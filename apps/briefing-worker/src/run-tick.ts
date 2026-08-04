import {
  claimJob,
  dueJobs,
  failRun,
  finishRun,
  recordArtifact,
  recordRunFindings,
  type ClaimedSlot,
  type DueJob,
  type PrismaClient,
  type RunFailure,
} from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import { jobKinds } from "./job-kind-registry.ts"
import {
  lookUpJobKind,
  type JobHandlerContext,
  type JobKindRegistry,
} from "./job-kinds.ts"

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
 *
 * The field list carries an invariant it cannot state in types:
 * **`succeeded + failed === claimed`**, because both of those are only ever
 * incremented inside the claimed branch. It is written down here so the next
 * reader inherits it rather than rediscovering it — and so that the next
 * counter added is weighed against it, the way `unhandled` was.
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
  /**
   * Jobs turned away before the claim, for naming a kind nothing handles.
   *
   * Its own counter rather than either neighbour's. `skipped` means another
   * party holds the slot, which is not an error, and an unhandled kind is a
   * fault; `failed` would fold it into the sum above and leave a reader who
   * trusted the invariant computing a phantom skipped job.
   *
   * Non-zero is the only thing that tells a reader to go looking for the
   * {@link UnhandledKindReport} lines, which are the whole record of it.
   */
  unhandled: number
}

/**
 * One JSON line per job whose kind nothing handles.
 *
 * The entire trace of that failure, which is why it is required rather than a
 * diagnostic nicety. The kind is decided before the claim, so there is no
 * `runs` row to write to — no `runs.failure`, nothing a later query can find —
 * and `runBriefing` is never reached, so the `briefing-run` line with
 * `outcome=failure` that the Errors alarm's runbook sends a reader to does not
 * exist for this failure mode either. Without this line the alarm names a
 * failed invocation and nothing anywhere names a job.
 */
export interface UnhandledKindReport {
  event: "unhandled-job-kind"
  jobId: string
  jobName: string
  /**
   * The discriminator as the row holds it, normalised only when it is absent.
   * Typed `unknown` because `42`, `null` and `""` are exactly the values that
   * reach here, and each of them is the fault worth printing.
   */
  kind: unknown
}

/**
 * The database, as a tick uses it.
 *
 * Every member is client-free — the real ones are bound to a `PrismaClient`
 * once, in {@link databaseFor} — so a fake is six functions rather than a
 * mocked Prisma. That is the point: whether a slot was claimed and what was
 * written to its run are the facts a tick's tests are about, and a module
 * binding can be observed by nothing.
 */
export interface TickDatabase {
  dueJobs: (now: Date) => Promise<DueJob[]>
  /** `undefined` means another party holds the slot — see the call site. */
  claimJob: (job: DueJob) => Promise<ClaimedSlot | undefined>
  finishRun: (runId: string, warnings?: RunFailure) => Promise<unknown>
  failRun: (runId: string, failure: RunFailure) => Promise<unknown>
  /**
   * The two the tick never calls itself — it hands them to the handler, which
   * is where they are described. Stated once, in `JobHandlerContext`, so the
   * port and the context cannot drift apart.
   */
  recordArtifact: JobHandlerContext["recordArtifact"]
  recordFindings: JobHandlerContext["recordFindings"]
}

export interface RunTickInput {
  prisma: PrismaClient
  briefs: BriefStore
  now?: Date
  /**
   * The whole port or none of it. A partial override would leave the calls it
   * left out bound to the real `prisma`, so a fake that forgot one would reach
   * Postgres from a test that believed it had replaced the database — the one
   * failure this seam exists to make impossible. Production supplies nothing.
   */
  db?: TickDatabase
  /**
   * What runs each kind of job. Optional, defaulting to the real registry, for
   * the reason `createScout` is optional on a run: dispatch can then be
   * exercised without an `OPENAI_API_KEY` or a Prisma fake.
   *
   * The one production caller passes neither this nor `db`. It was changed
   * once, deliberately — `runTick(prisma, briefs)` became
   * `runTick({ prisma, briefs })` — because an input object is what stops the
   * next injected dependency from being a fourth positional argument, and
   * `RunBriefingInput` had already made that trade.
   */
  kinds?: JobKindRegistry
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
export async function runTick(input: RunTickInput): Promise<TickReport> {
  const { prisma, briefs, now = new Date() } = input
  const db = input.db ?? databaseFor(prisma)
  const kinds = input.kinds ?? jobKinds

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
    unhandled: 0,
  }

  const failures: unknown[] = []
  const due = await db.dueJobs(now)
  report.due = due.length

  for (const job of due) {
    const { kind, handler } = lookUpJobKind(kinds, job.config)

    // Ahead of the claim, and that is the whole point of it being here: an
    // unhandled kind is knowable from the row alone, so claiming first would
    // advance `next_run_at`, insert a `running` row and spend the occurrence on
    // a job that never had a chance of running.
    //
    // What that costs is that the row never moves. It comes back every tick,
    // sorting steadily earlier because due jobs are ordered oldest-slot-first,
    // and fails every invocation of the worker until a human edits it. Pausing
    // it instead is one existing call away and was refused: `next_run_at = NULL`
    // is indistinguishable from a pause the user performed, and nothing renders
    // a `runs` row, so the job would quietly stop producing briefs with no
    // surface anywhere saying why. Failing loudly is ugly; disappearing quietly
    // is worse, and only one of the two corrects itself once someone looks.
    if (!handler) {
      report.unhandled += 1

      // Not "a config this worker cannot read" — that message belongs to a
      // config malformed *for its kind*, which is a different fault with a
      // different fix and, unlike this one, a `runs` row to be found in.
      failures.push(
        new Error(
          `Job "${job.name}" names a job kind this worker has no handler for: ${JSON.stringify(kind)}. Its slot was not claimed and nothing ran.`
        )
      )

      const unhandled: UnhandledKindReport = {
        event: "unhandled-job-kind",
        jobId: job.id,
        jobName: job.name,
        kind,
      }
      console.log(JSON.stringify(unhandled))
      continue
    }

    const slot = await db.claimJob(job)

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
      // What the slot means to a handler is `JobHandlerContext`'s to say now,
      // and it says it — this call knows only that a kind was found and that
      // the slot is the one just claimed.
      const outcome = await handler({
        job,
        slot,
        // A function, not the store: see `JobHandlerContext`. Every kind is
        // handed the same context, and only a kind that writes a brief asks.
        briefs: () => briefs,
        recordArtifact: db.recordArtifact,
        recordFindings: db.recordFindings,
      })

      // Third argument, and usually `undefined`. A run that produced a brief
      // but could not keep its findings is `succeeded` with a non-empty
      // `failure` — the rule `packages/db/src/types.ts` states.
      await db.finishRun(slot.runId, outcome.warnings)
      report.succeeded += 1
    } catch (error) {
      // Recorded, then carried. The row makes the failure queryable; the run
      // report `runBriefing` already emitted keeps the diagnostics, and remains
      // the only record if a run dies before it can write at all.
      await db
        .failRun(slot.runId, {
          message: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined)

      report.failed += 1
      failures.push(error)
    }
  }

  report.durationMs = Date.now() - startedAtMs
  console.log(JSON.stringify(report))

  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : // No denominator, rather than a corrected one. This used to name
        // `claimed`, which an unhandled kind never increments — a tick that
        // turned one job away and failed another read "2 of 1 claimed jobs
        // failed". `claimed + unhandled` would be true but would need a word
        // for a sum nothing else here has one for, and the tick line printed
        // immediately above already carries every count. So this says only
        // what it can count without inventing a term.
        new AggregateError(
          failures,
          `${failures.length} jobs failed this tick.`
        )
  }

  return report
}

/** The real operations, with the client bound in once. */
function databaseFor(prisma: PrismaClient): TickDatabase {
  return {
    dueJobs: (now) => dueJobs(prisma, now),
    claimJob: (job) => claimJob(prisma, job),
    finishRun: (runId, warnings) => finishRun(prisma, runId, warnings),
    failRun: (runId, failure) => failRun(prisma, runId, failure),
    recordArtifact: (runId, objectKey) =>
      recordArtifact(prisma, runId, objectKey),
    recordFindings: (runId, findings) =>
      recordRunFindings(prisma, runId, findings),
  }
}
