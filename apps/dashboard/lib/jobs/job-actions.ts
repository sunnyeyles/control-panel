import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { BRIEFING_NOT_FOUND } from "@/lib/actions/not-found"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  createJob,
  isDbError,
  isUniqueViolation,
  pauseJob,
  resumeJob,
  updateJobConfig,
  updateJobSchedule,
  type Job,
  type PrismaClient,
} from "@workspace/db"
import {
  DEFAULT_MAX_POSTINGS,
  MAX_POSTINGS_PER_BRIEF,
  type JobSearchConfig,
} from "@workspace/job-search"
import { z } from "zod"

import { fitsSearchBudget, MAX_ROLE_TITLES } from "./criteria-text"
import {
  isIntervalHours,
  SCHEDULE_TIMEZONE,
  toCron,
  type IntervalHours,
} from "./interval"
import { requireOwnedJob } from "./owned-job"
import { MAX_CRITERIA_ITEMS, searchCriteriaSchema } from "./search-criteria"

/**
 * The briefing actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/schedules/actions.ts`.
 *
 * On/off is not a column. `jobs.next_run_at IS NULL` means "not scheduled". So
 * "off" is `pauseJob()` and "on" is `resumeJob()`, and the question "is this
 * briefing on?" is `job.nextRunAt !== null` everywhere.
 */

/**
 * One message for "no such job" and "someone else's job".
 *
 * Shared with run-actions via `lib/actions/not-found.ts`. Distinct messages
 * would turn a form that takes a uuid into an oracle for whether another user's
 * row exists.
 */
const NOT_FOUND = BRIEFING_NOT_FOUND

/**
 * Only reachable by posting the form directly — the picker offers four values
 * and cannot produce a fifth — so the copy points at the UI rather than trying
 * to explain a cron expression the user never saw.
 */
const INVALID_INTERVAL = "Choose how often the briefing should run."

export interface JobActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The client, resolved per call rather than held.
   *
   * Called inside the action bodies, never in the factory, so
   * `createJobActions(...)` at module scope in the wrapper constructs nothing
   * and cannot throw at import time on a missing `DATABASE_URL`.
   */
  getPrisma: () => PrismaClient
  /** Overridden in tests, so an assertion can name the occurrence. */
  now?: () => Date
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

/**
 * `jobId` always arrives from the client, so it is validated as a uuid before it
 * reaches a query and is never trusted to name an *owner*.
 */
const jobIdSchema = z.uuid()

const setEnabledSchema = z.object({
  jobId: jobIdSchema,
  // A string, because it crosses a form boundary. `"false"` is a value here,
  // not an absence — the switch posts the transition it wants explicitly rather
  // than relying on checkbox semantics, where unchecked submits nothing at all.
  enabled: z.enum(["true", "false"]),
})

const scheduleSchema = z.object({ jobId: jobIdSchema })

const createSchema = z.object({ name: z.string().trim().min(1).max(80) })

/**
 * The whole of schedule validation, and it is a closed set rather than a parse.
 *
 * The form offers four intervals and nothing else, so an expression is never
 * accepted from the client — it is *derived* here from a value that is either
 * one of four numbers or rejected.
 */
function readIntervalHours(
  raw: FormDataEntryValue | null
): IntervalHours | undefined {
  if (typeof raw !== "string") return undefined

  const hours = Number(raw.trim())

  return isIntervalHours(hours) ? hours : undefined
}

/** The three criteria fields as a `jobs.config`, or the sentence to show. */
type CriteriaRead =
  { ok: true; config: JobSearchConfig } | { ok: false; message: string }

/**
 * The three criteria fields, parsed once for both the create and the edit form.
 *
 * Shared because the two post an identical set of fields and must refuse an
 * identical set of things: a config the edit form would accept and the create
 * form would not is a briefing a user can reach one way and not the other, for
 * no reason they could discover.
 */
function readCriteria(formData: FormData): CriteriaRead {
  const criteria = searchCriteriaSchema.safeParse({
    titles: formData.get("titles"),
    locations: formData.get("locations"),
    // Posted by the form as `""` when the user typed nothing, and absent
    // entirely — so `null` — when this action is called by something older than
    // the field. Both mean "none"; neither is a failure. See
    // `optionalCriteriaList` in ./search-criteria.
    keywords: formData.get("keywords"),
    // Same three-way absence as `keywords`, one type over: never posted,
    // posted blank, or an actual number. Only the create form collects it —
    // `EditCriteriaForm` never posts this field, so it always parses to
    // `undefined` there, which is what leaves an existing briefing's stored
    // value untouched. See `optionalPostingCount`.
    maxPostings: formData.get("maxPostings"),
  })

  // Titles and locations are not optional: the worker's `JobSearchConfigSchema`
  // requires both, so a job created without them would claim its first slot and
  // then fail to read its own config.
  //
  // ⚠️ **Two of the three optional-ish fields can reach here too**, and
  // answering either with the generic sentence would name the wrong field.
  // Optional means "may be empty", not "unbounded" — and the title cap is not
  // about paste size at all.
  if (!criteria.success) {
    // ⚠️ **A field is named only when it is the *only* thing wrong.** Asking
    // whether it merely appears among the issues gets the common case right and
    // the overlapping one backwards: a submit that fails on an empty `titles`
    // *and* an over-cap `keywords` would be answered with the keyword sentence,
    // so the user trims the list, submits again, and only then learns about the
    // field that was blocking them all along. One failure, two round trips, and
    // the first message named a field that was not the obstacle.
    const failed = new Set(criteria.error.issues.map((issue) => issue.path[0]))
    const only = (field: string) => failed.size === 1 && failed.has(field)

    // The case that hits the keyword cap is not a typist — it is **Suggest from
    // my resume** on a CV naming more technologies than the cap allows, which
    // fills the box and then fails on a submit the user has no reason to
    // connect to it.
    if (only("keywords")) {
      return {
        ok: false,
        message: `That is more than ${MAX_CRITERIA_ITEMS} keywords. Keep the list to the technologies that matter most for the roles you want — a longer one does not search harder.`,
      }
    }

    // Reachable only by posting the form directly — the field disables its own
    // submit at the cap — so the sentence explains the *reason* rather than
    // pointing at a control. See `MAX_ROLE_TITLES`.
    if (only("titles")) {
      return {
        ok: false,
        message: `A briefing searches for at most ${MAX_ROLE_TITLES} role titles. Every title is a separate search of every board, and a wider sweep than that is cut short rather than run. Split the rest into a second briefing.`,
      }
    }

    // The bound is the scout's rather than the form's — it has to read an
    // advertisement before it can report it — so the sentence says what to do
    // and not which schema said no.
    if (only("maxPostings")) {
      return {
        ok: false,
        message: `Ask for between 1 and ${MAX_POSTINGS_PER_BRIEF} postings, or leave it blank for ${DEFAULT_MAX_POSTINGS}.`,
      }
    }

    return {
      ok: false,
      message: "Add at least one role title and one location.",
    }
  }

  // ⚠️ **The combination, not either field alone.** Three titles is fine and
  // four locations is fine; together they are a sweep the scout is routed to
  // `halt` partway through, which still produces a well-formed brief covering
  // less than it was asked to. That failure is invisible from the outside,
  // which is why it is refused here rather than warned about.
  if (
    !fitsSearchBudget(
      criteria.data.titles.length,
      criteria.data.locations.length
    )
  ) {
    return {
      ok: false,
      message:
        "That is too wide to search in one briefing — every role title is searched in every location, on every board. Remove a title or a location, or split this into two briefings.",
    }
  }

  /**
   * No keywords means the field is *absent* from `config`, not present and
   * empty.
   *
   * The worker accepts `keywords: []` happily, so this is not about validation.
   * It is about what the row says: an absent field and an empty one should not
   * both have to mean "none", and a stored `[]` reads as a choice the user made
   * — someone (or something) having decided this briefing should match on no
   * technologies in particular. Leaving the key out keeps "never said"
   * distinguishable from "said none", which is the only form the question can
   * be asked in later.
   */
  const { keywords, maxPostings, ...requiredCriteria } = criteria.data

  // `optionalCriteriaList` pipes to a plain `z.array(...)`, so this is always a
  // `string[]` — an unfilled field arrives as `[]`, never as `undefined`.
  // Spelling the test `.length > 0` rather than `?.length` says that: an
  // optional chain here would imply an absent case the type forbids, and would
  // keep working if the schema ever grew one, which is precisely the change
  // that should fail loudly instead.
  //
  // `maxPostings` is left out on the same principle and for a stronger reason:
  // an absent field means "whatever the default is", so a briefing created
  // today follows the default when it changes, where a stored `20` would pin
  // this row to today's number for ever.
  return {
    ok: true,
    config: {
      ...requiredCriteria,
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(maxPostings === undefined ? {} : { maxPostings }),
    },
  }
}

export function createJobActions(deps: JobActionsDeps) {
  const now = deps.now ?? (() => new Date())
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  const requireCaller = () => requireUser(deps.getUser, "briefings")

  async function setJobEnabled(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched at all. `proxy.ts` cannot evaluate a non-GET
    // request, so for this POST it degrades to checking that *some* session
    // cookie substring is present — this is the only real check on the path.
    const caller = await requireCaller()
    if (!caller.ok) return fail(caller.message)

    const parsed = setEnabledSchema.safeParse({
      jobId: formData.get("jobId"),
      enabled: formData.get("enabled"),
    })

    if (!parsed.success) return fail(NOT_FOUND)

    const prisma = deps.getPrisma()

    const job = await requireOwnedJob(prisma, parsed.data.jobId, caller.userId)
    if (!job) return fail(NOT_FOUND)

    const enable = parsed.data.enabled === "true"

    try {
      // `resumeJob()` computes the next occurrence from *now*, so turning a
      // briefing back on never owes the slots it missed while off.
      const updated = enable
        ? await resumeJob(prisma, job.id, now())
        : await pauseJob(prisma, job.id)

      if (!updated) return fail(NOT_FOUND)
    } catch (error) {
      return fail(storeMessage("update", error))
    }

    return {
      status: "success",
      message: enable ? "Briefing turned on." : "Briefing turned off.",
      resetKey: newResetKey(),
    }
  }

  async function updateJobScheduleAction(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireCaller()
    if (!caller.ok) return fail(caller.message)

    const parsed = scheduleSchema.safeParse({ jobId: formData.get("jobId") })
    const hours = readIntervalHours(formData.get("hours"))

    if (!parsed.success) return fail(NOT_FOUND)
    if (!hours) return fail(INVALID_INTERVAL)

    const prisma = deps.getPrisma()

    const job = await requireOwnedJob(prisma, parsed.data.jobId, caller.userId)
    if (!job) return fail(NOT_FOUND)

    try {
      // A paused briefing stays paused: `updateJobSchedule` writes the new
      // occurrence only when there already was one.
      const updated = await updateJobSchedule(
        prisma,
        job.id,
        { cron: toCron(hours), timezone: SCHEDULE_TIMEZONE },
        now()
      )

      if (!updated) return fail(NOT_FOUND)
    } catch (error) {
      return fail(storeMessage("update", error))
    }

    return {
      status: "success",
      message:
        job.nextRunAt === null
          ? "Schedule saved. This briefing is still turned off."
          : "Schedule saved.",
      resetKey: newResetKey(),
    }
  }

  async function createJobAction(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireCaller()
    if (!caller.ok) return fail(caller.message)

    const parsed = createSchema.safeParse({ name: formData.get("name") })
    const hours = readIntervalHours(formData.get("hours"))

    if (!parsed.success) return fail("Give the briefing a name.")

    const criteria = readCriteria(formData)
    if (!criteria.ok) return fail(criteria.message)

    if (!hours) return fail(INVALID_INTERVAL)

    const { name } = parsed.data
    const { config } = criteria

    let job: Job

    try {
      job = await createJob(
        deps.getPrisma(),
        {
          // The session's userId, never a form field.
          userId: caller.userId,
          name,
          config,
          scheduleCron: toCron(hours),
          scheduleTimezone: SCHEDULE_TIMEZONE,
        },
        now()
      )
    } catch (error) {
      return fail(storeMessage("create", error))
    }

    return {
      status: "success",
      message: `Created “${job.name}”.`,
      resetKey: job.id,
    }
  }

  /**
   * Change what an existing briefing searches for.
   *
   * The criteria were write-once until this existed: the card showed a name, a
   * switch and a cadence, and changing a role title meant deleting the briefing
   * and building another — losing its name, its schedule and the fact that it
   * had been running. That was tolerable while the fields were three text boxes
   * typed once; it stopped being tolerable the moment the point of the feature
   * became *tuning* them after reading a thin brief.
   *
   * ⚠️ **Its `resetKey` is the job's id, and is therefore constant.** The
   * shared union requires the field on success, and every other action here
   * mints a fresh uuid because theirs is a form that should return to a blank
   * state. This one is an edit form over stored values: a changing key would
   * remount it and discard the very fields that were just saved, rebuilding
   * them from a server render that has not landed yet — the row flickering back
   * to its old titles for as long as the `refresh()` in the wrapper takes. A
   * constant makes that impossible whether the form keys on it or not.
   * `carryResetKey` still holds the previous key through a failure, so a
   * rejected save leaves what the user typed alone.
   */
  async function updateJobCriteriaAction(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireCaller()
    if (!caller.ok) return fail(caller.message)

    const parsed = scheduleSchema.safeParse({ jobId: formData.get("jobId") })
    if (!parsed.success) return fail(NOT_FOUND)

    const criteria = readCriteria(formData)
    if (!criteria.ok) return fail(criteria.message)

    const prisma = deps.getPrisma()

    // Ownership before the write, and from the session rather than the form.
    // `updateJobConfig` addresses any row in the table by id, exactly as every
    // other helper in `@workspace/db` does — this is the check that makes a
    // uuid in a form harmless.
    const job = await requireOwnedJob(prisma, parsed.data.jobId, caller.userId)
    if (!job) return fail(NOT_FOUND)

    try {
      const updated = await updateJobConfig(prisma, job.id, criteria.config)

      if (!updated) return fail(NOT_FOUND)
    } catch (error) {
      return fail(storeMessage("update", error))
    }

    return {
      status: "success",
      message: "Search criteria saved.",
      resetKey: job.id,
    }
  }

  return {
    setJobEnabled,
    updateJobSchedule: updateJobScheduleAction,
    updateJobCriteria: updateJobCriteriaAction,
    createJob: createJobAction,
  }
}

/**
 * A store failure as something safe to show.
 *
 * Branches on `code`, never `instanceof`, via `isDbError`. Unique violations
 * arrive as Prisma `P2002` (or raw `23505`) and are mapped via
 * `isUniqueViolation`.
 */
function storeMessage(operation: "create" | "update", error: unknown): string {
  console.error(`briefings: ${operation} failed`, error)

  if (operation === "create" && isUniqueViolation(error)) {
    return "You already have a briefing with that name."
  }

  if (isDbError(error)) {
    switch (error.code) {
      case "invalid_schedule":
        return INVALID_INTERVAL

      // No `database_unavailable` branch: @workspace/db no longer declares that
      // code, because nothing ever threw it — a connection or permission fault
      // arrives as Prisma's own error, never satisfies `isDbError`, and so
      // reaches the "Something went wrong." at the end of this function, which
      // is what it always did. It does not reach the `default` below. That
      // `never` is what will demand a branch here the day a second code is
      // added.
      default: {
        const _exhaustive: never = error.code
        return _exhaustive
      }
    }
  }

  return "Something went wrong."
}
