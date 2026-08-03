import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  createJob,
  isDbError,
  isUniqueViolation,
  pauseJob,
  resumeJob,
  updateJobSchedule,
  type Job,
  type PrismaClient,
} from "@workspace/db"
import { z } from "zod"

import {
  isIntervalHours,
  SCHEDULE_TIMEZONE,
  toCron,
  type IntervalHours,
} from "./interval"
import { searchCriteriaSchema } from "./search-criteria"

/**
 * The briefing actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/settings/actions.ts`.
 *
 * On/off is not a column. `jobs.next_run_at IS NULL` means "not scheduled". So
 * "off" is `pauseJob()` and "on" is `resumeJob()`, and the question "is this
 * briefing on?" is `job.nextRunAt !== null` everywhere.
 */

/**
 * One message for "no such job" and "someone else's job".
 *
 * Distinct messages would turn a form that takes a uuid into an oracle for
 * whether another user's row exists.
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

    const criteria = searchCriteriaSchema.safeParse({
      titles: formData.get("titles"),
      locations: formData.get("locations"),
    })

    // Not optional: the worker's `JobSearchConfigSchema` requires both, so a
    // job created without them would claim its first slot and then fail to read
    // its own config.
    if (!criteria.success) {
      return fail("Add at least one role title and one location.")
    }

    if (!hours) return fail(INVALID_INTERVAL)

    const { name } = parsed.data

    let job: Job

    try {
      job = await createJob(
        deps.getPrisma(),
        {
          // The session's userId, never a form field.
          userId: caller.userId,
          name,
          config: criteria.data,
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

  return {
    setJobEnabled,
    updateJobSchedule: updateJobScheduleAction,
    createJob: createJobAction,
  }
}

/**
 * The ownership boundary.
 *
 * Job helpers take an id and **do not filter by `user_id`** — the worker's tick
 * legitimately operates across every user's jobs. So a `jobId` from a form
 * addresses any row in the table, and the check has to happen here.
 *
 * Returns `undefined` for both "no such row" and "not yours".
 */
async function requireOwnedJob(
  prisma: PrismaClient,
  jobId: string,
  userId: string
): Promise<Job | undefined> {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job || job.userId !== userId) return undefined

  return job
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

      case "database_unavailable":
        return "The database is unavailable. Try again in a moment."

      default: {
        const _exhaustive: never = error.code
        return _exhaustive
      }
    }
  }

  return "Something went wrong."
}
