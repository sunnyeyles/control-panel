import {
  claimJob,
  dueJobs,
  failRun,
  finishRun,
  recordArtifact,
  recordRunFindings,
  type PrismaClient,
} from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import { runBriefing } from "./run-briefing.ts"

/**
 * The worker is no longer "the thing that runs at 09:00". It is "the thing that
 * runs hourly and asks what is due".
 *
 * The cadence of an individual job lives in Postgres — `jobs.schedule_cron` and
 * `jobs.schedule_timezone` — because adding a second job with a different
 * cadence should cost an INSERT rather than a Terraform apply. What stayed in
 * Terraform is the tick itself, which is now the same for every job and so has
 * nothing left to drift.
 *
 * Platform-independent on purpose, like `run-briefing.ts`: it takes a Prisma
 * client and a `BriefStore` rather than making either, so everything AWS-shaped
 * stays in `index.ts`.
 */

/**
 * One line per tick, alongside the per-run reports.
 *
 * The run report answers "what happened in this run". This answers the question
 * a run report structurally cannot: "was there anything to do, and did anything
 * get skipped". A tick that finds nothing due is a success and emits `due: 0`,
 * which is how silence gets distinguished from breakage in the logs.
 */
export interface TickReport {
  event: "tick"
  startedAt: string
  durationMs: number
  /** Jobs whose slot had arrived. */
  due: number
  /** Slots this tick won. */
  claimed: number
  /** Slots another party already held. Not an error. */
  skipped: number
  succeeded: number
  failed: number
}

/**
 * Ask what is due, claim each slot, run it, record the outcome.
 *
 * **Sequential, in one invocation.** The map left this open, and sequential is
 * the answer while a tick is expected to find zero or one due job: fanning out
 * means a second Lambda, a second set of permissions and a second failure mode,
 * bought to parallelise a list that is usually empty. The Lambda timeout bounds
 * it, and `dueJobs()` is limited, so a backlog is worked oldest-slot-first
 * across several ticks rather than attempted all at once.
 *
 * Rethrows if any job failed. That is the contract the alarm depends on: a
 * throw marks the invocation failed and produces the `Errors` datapoint, so a
 * bad run is visible without anyone reading logs. Every due job is attempted
 * first — one failing job must not stop the others from running.
 */
export async function runTick(
  prisma: PrismaClient,
  briefs: BriefStore,
  now: Date = new Date()
): Promise<TickReport> {
  const startedAtMs = Date.now()
  const report: TickReport = {
    event: "tick",
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    due: 0,
    claimed: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
  }

  const failures: unknown[] = []
  const due = await dueJobs(prisma, now)
  report.due = due.length

  for (const job of due) {
    const slot = await claimJob(prisma, job)

    // Another party holds this slot — an overlapping tick, a manual invoke, an
    // operator resetting `next_run_at` by hand. Skip the job entirely: do not
    // run it, do not retry it, do not touch the row. Every duplicate occurrence
    // is a paid LLM run.
    if (!slot) {
      report.skipped += 1
      continue
    }

    report.claimed += 1

    try {
      // `slot.scheduledFor` is the occurrence, and is what the brief's S3
      // partition day is derived from — not the instant the run finishes, or a
      // 23:30 slot completing after midnight files under a day its run row
      // disagrees with.
      const briefing = await runBriefing({
        job,
        slot,
        briefs,
        recordArtifact: (runId, objectKey) =>
          recordArtifact(prisma, runId, objectKey),
        recordFindings: (runId, findings) =>
          recordRunFindings(prisma, runId, findings),
      })

      // Third argument, and usually `undefined`. A run that produced a brief
      // but could not keep its findings is `succeeded` with a non-empty
      // `failure` — the rule `packages/db/src/types.ts` states.
      await finishRun(prisma, slot.runId, briefing.warnings)
      report.succeeded += 1
    } catch (error) {
      // Recorded, then carried. The row makes the failure queryable; the run
      // report `runBriefing` already emitted keeps the diagnostics, and remains
      // the only record if a run dies before it can write at all.
      await failRun(prisma, slot.runId, {
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)

      report.failed += 1
      failures.push(error)
    }
  }

  report.durationMs = Date.now() - startedAtMs
  console.log(JSON.stringify(report))

  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          `${failures.length} of ${report.claimed} claimed jobs failed.`
        )
  }

  return report
}
