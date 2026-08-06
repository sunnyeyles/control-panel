import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { BRIEFING_NOT_FOUND } from "@/lib/actions/not-found"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { requireOwnedJob } from "@/lib/jobs/owned-job"
import {
  failRun,
  runningRunForJob,
  startAdHocRun,
  type PrismaClient,
} from "@workspace/db"
import { z } from "zod"

import type { BriefingInvoker } from "./invoke-worker"
import { staleBefore } from "./staleness"

/**
 * Starting a briefing now, rather than when its cadence next comes round.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/briefings/actions.ts`.
 *
 * The run this starts is **ad-hoc**: it occupies no scheduled occurrence, so it
 * neither consumes the next slot nor moves `next_run_at`, and it works on a
 * briefing that is turned off. `runs.scheduled_for IS NULL` is what says so, and
 * the partial unique index that makes scheduled slots at-most-once deliberately
 * does not cover it.
 *
 * ⚠️ **The row is written here and the work happens elsewhere.** This inserts
 * the `runs` row and then asks the worker to pick it up; the worker claims it
 * and runs the pipeline. Writing the row first is what gives the click
 * something to render immediately, gives a second click something to be refused
 * against, and leaves a record when the invoke itself fails — none of which
 * exist if the worker is left to insert on arrival, several seconds later.
 */

/**
 * One message for "no such briefing" and "someone else's briefing".
 *
 * Shared with job-actions via `lib/actions/not-found.ts`. Distinct messages
 * would turn a form that takes a uuid into an oracle for whether another user's
 * row exists.
 */
const NOT_FOUND = BRIEFING_NOT_FOUND

/**
 * Refusing a second run while one is going is the spend control on this button.
 * Not a race guard — two clicks a millisecond apart can still both pass this
 * read — but every duplicate is a paid LLM run, and the cheap check removes the
 * case that actually happens: a person clicking again because nothing looked
 * like it moved.
 */
const ALREADY_RUNNING = "This briefing is already running."

const triggerSchema = z.object({ jobId: z.uuid() })

export interface RunActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * Resolved per call rather than held, so `createRunActions(...)` at module
   * scope in the wrapper constructs nothing and cannot throw at import time on
   * a missing `DATABASE_URL`.
   */
  getPrisma: () => PrismaClient
  /** Same reasoning, for `BRIEFING_WORKER_FUNCTION_NAME` and the role. */
  getInvoker: () => BriefingInvoker
  /** Overridden in tests, so an assertion can name the instant. */
  now?: () => Date
}

export function createRunActions(deps: RunActionsDeps) {
  const now = deps.now ?? (() => new Date())

  async function triggerBriefingRun(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched at all. `proxy.ts` cannot evaluate a non-GET
    // request, so for this POST it degrades to checking that *some* session
    // cookie substring is present — this is the only real check on the path.
    const caller = await requireUser(deps.getUser, "briefings")
    if (!caller.ok) return fail(caller.message)

    const parsed = triggerSchema.safeParse({ jobId: formData.get("jobId") })
    if (!parsed.success) return fail(NOT_FOUND)

    const prisma = deps.getPrisma()

    const job = await requireOwnedJob(prisma, parsed.data.jobId, caller.userId)
    if (!job) return fail(NOT_FOUND)

    const at = now()

    try {
      const inFlight = await runningRunForJob(prisma, job.id, staleBefore(at))
      if (inFlight) return fail(ALREADY_RUNNING)
    } catch (error) {
      return fail(storeMessage("check", error))
    }

    let runId: string

    try {
      const run = await startAdHocRun(prisma, job.id)
      runId = run.id
    } catch (error) {
      return fail(storeMessage("start", error))
    }

    try {
      await deps.getInvoker().requestRun({ runId, jobId: job.id })
    } catch (error) {
      console.error("briefings: could not reach the worker", error)

      // The row exists and says `running`, so leaving it would show a spinner
      // for a run that will never begin — until the staleness bound cleared it
      // fifteen minutes later. Closing it here is what makes a refused invoke
      // look like the immediate failure it is.
      await failRun(prisma, runId, {
        message: "The worker could not be reached.",
      }).catch(() => undefined)

      return fail("Could not start the briefing. Try again in a moment.")
    }

    return {
      status: "success",
      message: "Running now. This usually takes a minute or two.",
      // The run's own id: distinct per success, which is all a reset key has to
      // be, and it identifies the thing that was just started.
      resetKey: runId,
    }
  }

  return { triggerBriefingRun }
}

/**
 * A store failure as something safe to show.
 *
 * No branch on `isDbError`: neither read nor insert here has a domain-specific
 * failure to translate — a unique violation is impossible for an ad-hoc run, by
 * the same partial index that makes unlimited ones legal — so anything reaching
 * this is infrastructural and says so.
 */
function storeMessage(operation: "check" | "start", error: unknown): string {
  console.error(`briefings: could not ${operation} a run`, error)
  return "Something went wrong."
}
