import { claimJob, dueJobs, type PrismaClient } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import {
  defaultJobKindRegistry,
  resolveJobKindEntry,
  type JobKindEntry,
} from "./job-kinds.ts"

/**
 * The worker runs hourly and asks what is due. A job's own cadence lives in
 * Postgres (`jobs.schedule_cron`, `jobs.schedule_timezone`) so a second job
 * costs an INSERT rather than a Terraform apply; only the tick stayed in
 * Terraform, and it is the same for every job.
 *
 * Platform-independent on purpose, like `run-briefing.ts`: it takes a Prisma
 * client and a `BriefStore` rather than making either.
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
 * **Sequential, in one invocation**, while a tick is expected to find zero or
 * one due job: fanning out buys a second Lambda and a second failure mode to
 * parallelise a usually-empty list. `dueJobs()` is limited, so a backlog is
 * worked oldest-slot-first across several ticks.
 *
 * Rethrows if any job failed — the contract the alarm depends on, since the
 * throw produces the `Errors` datapoint. Every due job is attempted first.
 *
 * Kind lookup and config validation happen **before** `claimJob`: both are
 * knowable from the row alone, and claiming a slot to discover them would
 * advance `next_run_at` for a job that never had a chance. They still count
 * toward the rethrow.
 */
export async function runTick(
  prisma: PrismaClient,
  briefs: BriefStore,
  now: Date = new Date(),
  registry: readonly JobKindEntry[] = defaultJobKindRegistry
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
    let entry: JobKindEntry
    try {
      entry = resolveJobKindEntry(registry, job)
    } catch (error) {
      // No claim. The row's `next_run_at` stays put — Decision 3 of the job-kind
      // plan — and the failure still fails the tick so the alarm fires.
      report.failed += 1
      failures.push(error)
      continue
    }

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
      await entry.handle({
        job,
        slot,
        trigger: "schedule",
        prisma,
        briefs,
      })
      report.succeeded += 1
    } catch (error) {
      // `executeClaimedBriefing` (via the briefing handler) has already recorded
      // the failure on the row. Carry it so the tick rethrows after every due
      // job has been attempted.
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
          `${failures.length} of ${report.due} due jobs failed.`
        )
  }

  return report
}
