import {
  failRun,
  finishRun,
  titleExclusions,
  type Job,
  type PrismaClient,
} from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import { prismaRecorders } from "./recorders.ts"
import { runBriefing, type SuccessReport } from "./run-briefing.ts"

/**
 * The shared spine after a slot (or ad-hoc row) is already claimed.
 *
 * Both `runTick` and `runAdHocBriefing` used to spell this out: load the user's
 * title exclusions, run the briefing, finish the row (or warn on a lost race),
 * and on failure record then rethrow. `recorders.ts` pulled the Prisma closures
 * out; this pulls the outcome wiring out so the two entry points stay about
 * claiming and reporting, not about how a claimed run is executed.
 */

export interface ClaimedBriefingInput {
  job: Job
  slot: { runId: string; scheduledFor: Date }
  /** Reported on the run line — `schedule` for the tick, `manual` for ad-hoc. */
  trigger: "schedule" | "manual"
}

/**
 * Run a claimed briefing to a terminal `runs` row.
 *
 * On success, finishes the row (carrying any soft-fail warnings). On failure,
 * records `failRun` and rethrows — the tick turns that into the Lambda `Errors`
 * datapoint; ad-hoc catches and returns rather than throws.
 */
export async function executeClaimedBriefing(
  prisma: PrismaClient,
  briefs: BriefStore,
  input: ClaimedBriefingInput
): Promise<SuccessReport> {
  const { job, slot, trigger } = input

  try {
    // Read after the claim, not before: a slot another party already holds
    // costs no query at all, and this is the only place that knows the run
    // is really going ahead. The list is the *user's* and not the job's,
    // which is why it is loaded here rather than parsed out of `job.config`.
    const briefing = await runBriefing({
      job,
      slot,
      briefs,
      trigger,
      titleExclusions: await titleExclusions(prisma, job.userId),
      ...prismaRecorders(prisma, {
        userId: job.userId,
        seenAt: slot.scheduledFor,
      }),
    })

    // Third argument, and usually `undefined`. A run that produced a brief
    // but could not keep its findings, or could not add what it found to the
    // cumulative record, is `succeeded` with a non-empty `failure` — the rule
    // `packages/db/src/types.ts` states.
    //
    // `false` is a lost race — the row was already terminal, so someone else
    // decided this run's outcome. The work still happened and the brief is
    // stored, so it counts as succeeded here; the log line is the only trace
    // the lost transition leaves.
    if (!(await finishRun(prisma, slot.runId, briefing.warnings))) {
      console.warn(
        `run ${slot.runId}: already terminal when this run went to finish it`
      )
    }

    return briefing
  } catch (error) {
    // Recorded, then rethrown. The row makes the failure queryable; the run
    // report `runBriefing` already emitted keeps the diagnostics, and remains
    // the only record if a run dies before it can write at all.
    await failRun(prisma, slot.runId, {
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)

    throw error
  }
}
