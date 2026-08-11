import { claimAdHocRun, failRun, type PrismaClient } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import { executeClaimedBriefing } from "./execute-claimed-briefing.ts"

/**
 * One briefing, run because a person asked for it rather than because a slot
 * arrived.
 *
 * The counterpart of `run-tick.ts`, and platform-independent for the same
 * reason: it takes a Prisma client and a `BriefStore` rather than making
 * either, so everything AWS-shaped stays in `index.ts`.
 *
 * **It claims no slot and never touches `next_run_at`.** An ad-hoc run occupies
 * no occurrence — that is what `runs.scheduled_for IS NULL` means — so pressing
 * the button neither consumes the next scheduled run nor brings it forward, and
 * it works on a briefing that is turned off. The pipeline it drives is byte for
 * byte the one the tick drives.
 *
 * The `runs` row already exists when this is called: the dashboard inserts it
 * and hands the id over, so that the moment of the click has a row to show, a
 * second click has something to be refused against, and an invoke that never
 * arrives leaves a record. This function's first job is therefore to *claim*
 * that row rather than create one.
 */

/** One line per ad-hoc run, the counterpart of `TickReport`. */
export interface AdHocReport {
  event: "ad-hoc-run"
  runId: string
  /**
   * What became of it.
   *
   * `skipped` is not a failure and is the expected outcome of a duplicate
   * delivery — see {@link runAdHocBriefing} on why one is expected at all.
   */
  outcome: "succeeded" | "failed" | "skipped"
  /** Present on `skipped` and `failed`; the diagnostic, not a user message. */
  reason?: string
  durationMs: number
}

export interface AdHocRequest {
  /** The `runs` row to claim. Authoritative — the job is read from it. */
  runId: string
  /**
   * The job the caller believed it was triggering.
   *
   * Checked against the row rather than trusted. It costs nothing and it means
   * a payload that has been tampered with, or a run id pasted against the wrong
   * briefing, fails loudly instead of quietly running the wrong search.
   */
  jobId: string
}

/**
 * Claim the run, execute it, record the outcome.
 *
 * **Returns rather than throws on failure, unlike `runTick`.** The tick rethrows
 * because that throw is what produces the Lambda `Errors` datapoint its alarm
 * watches. A run someone triggered already reports its failure twice over — on
 * the `runs` row, and in the UI that is watching it — and routing it into the
 * alarm as well would spend the only signal that says *the schedule is broken*
 * on something a person can already see. The hourly tick still throws, so a
 * worker that is genuinely broken is still caught within the hour.
 *
 * A claim that comes back empty means another delivery of the same invocation
 * already has this run, or the run is terminal. Both end the same way: do
 * nothing at all. AWS delivers an asynchronous invocation *at least* once, so a
 * duplicate is an expected event rather than a fault, and every duplicate that
 * ran would be a second paid LLM run.
 */
export async function runAdHocBriefing(
  prisma: PrismaClient,
  briefs: BriefStore,
  request: AdHocRequest,
  now: Date = new Date()
): Promise<AdHocReport> {
  const startedAtMs = Date.now()

  const report = (
    outcome: AdHocReport["outcome"],
    reason?: string
  ): AdHocReport => {
    const line: AdHocReport = {
      event: "ad-hoc-run",
      runId: request.runId,
      outcome,
      durationMs: Date.now() - startedAtMs,
      ...(reason === undefined ? {} : { reason }),
    }

    console.log(JSON.stringify(line))
    return line
  }

  const claimed = await claimAdHocRun(prisma, request.runId, now)
  if (!claimed) {
    return report(
      "skipped",
      "The run was already claimed or is no longer running."
    )
  }

  if (claimed.jobId !== request.jobId) {
    const message = `Run ${request.runId} belongs to job ${claimed.jobId}, not the ${request.jobId} the request named.`
    await failRun(prisma, request.runId, { message }).catch(() => undefined)
    return report("failed", message)
  }

  const job = await prisma.job.findUnique({ where: { id: claimed.jobId } })
  if (!job) {
    const message = `Job ${claimed.jobId} no longer exists.`
    await failRun(prisma, request.runId, { message }).catch(() => undefined)
    return report("failed", message)
  }

  try {
    // `claimed.startedAt` — the row's own value — rather than `now`. The
    // object key partitions on this, and taking it from the row is what keeps
    // the key derivable from the run alone, exactly as a claimed slot is for
    // a scheduled run.
    await executeClaimedBriefing(prisma, briefs, {
      job,
      slot: { runId: request.runId, scheduledFor: claimed.startedAt },
      trigger: "manual",
    })
    return report("succeeded")
  } catch (error) {
    // `executeClaimedBriefing` has already recorded the failure on the row.
    // Returned, not thrown — see the function docblock on why ad-hoc must not
    // feed the Errors alarm.
    const message = error instanceof Error ? error.message : String(error)
    return report("failed", message)
  }
}
