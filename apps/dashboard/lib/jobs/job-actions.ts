import type { CurrentUser } from "@/lib/auth/current-user"
import type { JobStore } from "@workspace/db/jobs"
import type { Job } from "@workspace/db/rows"
import { z } from "zod"

import type { JobActionState } from "./action-state"
import {
  isIntervalHours,
  SCHEDULE_TIMEZONE,
  toCron,
  type IntervalHours,
} from "./interval"
import { searchCriteriaSchema } from "./search-criteria"

export type { JobActionState } from "./action-state"

/**
 * The briefing actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/settings/actions.ts`. Same shape as
 * `lib/documents/document-actions.ts` and `lib/chat-handler.ts`.
 *
 * On/off is not a column. `jobs.next_run_at IS NULL` means "not scheduled", and
 * `packages/db/migrations/0001_init.sql` says why there is no `enabled` flag to
 * set instead. So "off" is `pause()` and "on" is `resume()`, and the question
 * "is this briefing on?" is `job.nextRunAt !== null` everywhere.
 */

/**
 * One message for both "not signed in" and "signed in but not allowed".
 *
 * Identical on purpose, exactly as in `document-actions.ts`: telling the second
 * caller apart from the first confirms to someone outside the allowlist that
 * their account exists and is merely unapproved.
 */
const NOT_AUTHORIZED = "You are not signed in."

/**
 * One message for "no such job" and "someone else's job".
 *
 * The same conflation `document-actions.ts` makes for `object_not_found` and
 * `object_ownership`, and for the same reason: distinct messages would turn a
 * form that takes a uuid into an oracle for whether another user's row exists.
 */
const NOT_FOUND = "That briefing could not be found."

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
   * The store, resolved per call rather than held.
   *
   * Called inside the action bodies, never in the factory, so
   * `createJobActions(...)` at module scope in the wrapper constructs nothing
   * and cannot throw at import time on a missing `DATABASE_URL`.
   */
  getJobs: () => JobStore
  /** Overridden in tests, so an assertion can name the occurrence. */
  now?: () => Date
  /** Overridden in tests, so an assertion can name the nonce. */
  newNonce?: () => string
}

/**
 * `jobId` always arrives from the client, so it is validated as a uuid before it
 * reaches a query and is never trusted to name an *owner* — see
 * {@link JobActionsDeps} and `requireOwnedJob` below.
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
 * one of four numbers or rejected. That removes the class of failure the old
 * free-text cron field had: there is no way to post a valid-looking expression
 * that means something the UI never showed.
 */
function readIntervalHours(
  raw: FormDataEntryValue | null
): IntervalHours | undefined {
  if (typeof raw !== "string") return undefined

  const hours = Number(raw.trim())

  return isIntervalHours(hours) ? hours : undefined
}

export function createJobActions(deps: JobActionsDeps) {
  const now = deps.now ?? (() => new Date())
  const newNonce = deps.newNonce ?? (() => crypto.randomUUID())

  /**
   * Resolve the caller, or the message to show instead.
   *
   * A thrown error here is treated as "not authorized" rather than propagated:
   * `getCurrentUser` touches the database to map an auth id onto a platform
   * user, and a database blip must not turn into an unauthenticated write.
   */
  async function requireUser(): Promise<
    { ok: true; userId: string } | { ok: false; message: string }
  > {
    let user: CurrentUser

    try {
      user = await deps.getUser()
    } catch (error) {
      console.error("briefings: failed to resolve the caller", error)
      return { ok: false, message: NOT_AUTHORIZED }
    }

    if (user.status !== "ok") return { ok: false, message: NOT_AUTHORIZED }

    return { ok: true, userId: user.userId }
  }

  /**
   * The ownership boundary, and the reason it is a function.
   *
   * `pause`, `resume` and `updateSchedule` take an id and **do not filter by
   * `user_id`** — `JobStore` is not a per-user facade the way `ResumeStore` is,
   * because the worker's tick legitimately operates across every user's jobs.
   * So a `jobId` from a form addresses any row in the table, and the check has
   * to happen here. Every mutating action routes through this; none of them
   * touches the store with a client-supplied id first.
   *
   * Returns `undefined` for both "no such row" and "not yours", so the two are
   * indistinguishable from outside.
   */
  async function requireOwnedJob(
    jobs: JobStore,
    jobId: string,
    userId: string
  ): Promise<Job | undefined> {
    const job = await jobs.get(jobId)
    if (!job || job.userId !== userId) return undefined

    return job
  }

  async function setJobEnabled(
    state: JobActionState,
    formData: FormData
  ): Promise<JobActionState> {
    const fail = (message: string) => carryNonce(state, message)

    // Before the body is touched at all. `proxy.ts` cannot evaluate a non-GET
    // request, so for this POST it degrades to checking that *some* session
    // cookie substring is present — this is the only real check on the path.
    const caller = await requireUser()
    if (!caller.ok) return fail(caller.message)

    const parsed = setEnabledSchema.safeParse({
      jobId: formData.get("jobId"),
      enabled: formData.get("enabled"),
    })

    if (!parsed.success) return fail(NOT_FOUND)

    const jobs = deps.getJobs()

    const job = await requireOwnedJob(jobs, parsed.data.jobId, caller.userId)
    if (!job) return fail(NOT_FOUND)

    const enable = parsed.data.enabled === "true"

    try {
      // `resume()` computes the next occurrence from *now*, so turning a
      // briefing back on never owes the slots it missed while off — a job that
      // was paused for a week is due once, not seven times.
      const updated = enable
        ? await jobs.resume(job.id, now())
        : await jobs.pause(job.id)

      if (!updated) return fail(NOT_FOUND)
    } catch (error) {
      return fail(storeMessage("update", error))
    }

    return {
      status: "success",
      message: enable ? "Briefing turned on." : "Briefing turned off.",
      nonce: newNonce(),
    }
  }

  async function updateJobSchedule(
    state: JobActionState,
    formData: FormData
  ): Promise<JobActionState> {
    const fail = (message: string) => carryNonce(state, message)

    const caller = await requireUser()
    if (!caller.ok) return fail(caller.message)

    const parsed = scheduleSchema.safeParse({ jobId: formData.get("jobId") })
    const hours = readIntervalHours(formData.get("hours"))

    if (!parsed.success) return fail(NOT_FOUND)
    if (!hours) return fail(INVALID_INTERVAL)

    const jobs = deps.getJobs()

    const job = await requireOwnedJob(jobs, parsed.data.jobId, caller.userId)
    if (!job) return fail(NOT_FOUND)

    try {
      // A paused briefing stays paused: `updateSchedule` writes the new
      // occurrence only when there already was one. Changing the interval must
      // not be a way to switch a briefing back on by accident.
      //
      // The try/catch is still required even though the expression is derived
      // from a closed set: `updateSchedule` re-parses it and signals failure by
      // *throwing* `InvalidScheduleError`, unlike every other method here, which
      // returns `undefined`.
      const updated = await jobs.updateSchedule(
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
      nonce: newNonce(),
    }
  }

  async function createJob(
    state: JobActionState,
    formData: FormData
  ): Promise<JobActionState> {
    const fail = (message: string) => carryNonce(state, message)

    const caller = await requireUser()
    if (!caller.ok) return fail(caller.message)

    const parsed = createSchema.safeParse({ name: formData.get("name") })
    const hours = readIntervalHours(formData.get("hours"))

    if (!parsed.success) return fail("Give the briefing a name.")

    const criteria = searchCriteriaSchema.safeParse({
      titles: formData.get("titles"),
      locations: formData.get("locations"),
    })

    // Not optional, and not a nicety. The worker's `JobSearchConfigSchema`
    // requires both, so a job created without them would claim its first slot
    // and then fail to read its own config — see `search-criteria.ts`.
    if (!criteria.success) {
      return fail("Add at least one role title and one location.")
    }

    if (!hours) return fail(INVALID_INTERVAL)

    const { name } = parsed.data

    let job: Job

    try {
      job = await deps.getJobs().create(
        {
          // The session's userId, never a form field. This is the same rule the
          // document actions follow, and here it is what makes `jobs.user_id`
          // — and therefore every S3 key the resulting brief lands under —
          // impossible to point at someone else.
          userId: caller.userId,
          name,
          config: criteria.data,
          scheduleCron: toCron(hours),
          scheduleTimezone: SCHEDULE_TIMEZONE,
        },
        now()
      )
    } catch (error) {
      return fail(createMessage(error))
    }

    // The new row's id: unique per success by construction, so the create form
    // can key its fields on it and clear without an effect.
    return {
      status: "success",
      message: `Created “${job.name}”.`,
      nonce: job.id,
    }
  }

  return { setJobEnabled, updateJobSchedule, createJob }
}

/**
 * An error state that preserves whatever nonce the previous state held.
 *
 * Lifted wholesale from `document-actions.ts`, including the reasoning: the
 * create form keys its fields on the nonce, so a failure that dropped it would
 * remount the fields and throw away what the user typed underneath the message
 * telling them to fix it. A failure is not a success and must not move that
 * number.
 */
function carryNonce(previous: JobActionState, message: string): JobActionState {
  const nonce = previous.status === "idle" ? undefined : previous.nonce

  return { status: "error", message, ...(nonce ? { nonce } : {}) }
}

/**
 * A store failure as something safe to show.
 *
 * Branches on `code`, never `instanceof` — `packages/db/src/errors.ts` says so
 * explicitly, because an error crossing a bundler or package boundary can fail
 * a prototype check while carrying a perfectly good discriminant.
 */
function storeMessage(operation: "create" | "update", error: unknown): string {
  console.error(`briefings: ${operation} failed`, error)

  // Not reachable from the form, since the expression is derived from a closed
  // set — but `updateSchedule` and `create` are the two calls that throw rather
  // than return, so the branch stays rather than becoming an opaque digest if a
  // future interval is added wrong.
  if (isDbErrorCode(error, "invalid_schedule")) return INVALID_INTERVAL

  if (isDbErrorCode(error, "database_unavailable")) {
    return "The database is unavailable. Try again in a moment."
  }

  return "Something went wrong."
}

/**
 * Create's extra failure: the name is already taken.
 *
 * `jobs` carries `unique (user_id, name)`, and `packages/db/src/client.ts`
 * deliberately remaps only class-08 connection faults — a constraint violation
 * is "a real result, not a transport failure" — so this arrives as a raw
 * Postgres error carrying `23505`. Left uncaught it would reach the client as
 * an opaque Next digest.
 */
function createMessage(error: unknown): string {
  if (isUniqueViolation(error)) {
    console.error("briefings: create rejected a duplicate name", error)
    return "You already have a briefing with that name."
  }

  return storeMessage("create", error)
}

function isDbErrorCode(error: unknown, code: string): boolean {
  return readCode(error) === code
}

function isUniqueViolation(error: unknown): boolean {
  return readCode(error) === "23505"
}

function readCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined

  return (error as { code?: unknown }).code
}
