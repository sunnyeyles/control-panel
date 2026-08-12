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
 * no occurrence — that is what `runs.scheduled_for IS NULL` means — so the
 * button neither consumes nor advances the next scheduled run, and it works on
 * a briefing that is turned off.
 *
 * The `runs` row already exists: the dashboard inserts it and hands the id
 * over, so the click has a row to show, a second click has something to be
 * refused against, and an invoke that never arrives leaves a record. This
 * function *claims* that row rather than creating one.
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
 * **Returns rather than throws on failure, unlike `runTick`.** The tick's throw
 * is what produces the Lambda `Errors` datapoint its alarm watches; a run
 * someone triggered already reports its failure on the row and in the UI, and
 * feeding the alarm too would spend the only *the schedule is broken* signal on
 * something a person can already see.
 *
 * An empty claim means a duplicate delivery already has this run, or the run is
 * terminal; both do nothing. AWS delivers asynchronous invocations *at least*
 * once, and every duplicate that ran would be a second paid LLM run.
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
