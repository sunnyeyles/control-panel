import { Prisma, type PrismaClient } from "./generated/prisma/client.ts"
import type { Run, RunFailure, RunFindings, RunStatus } from "./types.ts"

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Begin a run with no scheduled occurrence.
 *
 * Unconstrained on purpose: the partial unique index only covers non-NULL
 * `scheduled_for`, so ad-hoc runs never collide with each other.
 */
export async function startAdHocRun(
  prisma: DbClient,
  jobId: string
): Promise<Run> {
  return prisma.run.create({
    data: {
      jobId,
      scheduledFor: null,
      status: "running" satisfies RunStatus,
    },
  })
}

/** What a successful ad-hoc claim returns. */
export interface ClaimedRun {
  /** The job the run belongs to, read from the row rather than the caller. */
  jobId: string
  /**
   * When the run was requested.
   *
   * The ad-hoc counterpart of `ClaimedSlot.scheduledFor`: it is the occurrence
   * the brief is filed under, and taking it from the row rather than from the
   * clock is what keeps the object key derivable from the run alone — a second
   * delivery would otherwise partition on a different instant.
   */
  startedAt: Date
}

/**
 * Take an ad-hoc run, or find out someone else has it.
 *
 * Returns `undefined` when the run was already claimed, is already terminal, or
 * does not exist. **The caller must then do nothing at all** — not run it, not
 * retry it, not touch the row. The contract is `claimJob`'s, for the same
 * reason: every duplicate occurrence is a paid LLM run.
 *
 * The scheduled path needs no equivalent because `claimJob` claims the slot and
 * the partial unique index on `(job_id, scheduled_for)` makes that at-most-once.
 * An ad-hoc run has no slot to claim — that is what `scheduled_for IS NULL`
 * means — so the guard moves onto the run row itself, and `claimed_at` is what
 * carries it. This matters because the trigger is an asynchronous Lambda
 * invocation, which AWS delivers *at least* once.
 *
 * `updateMany` rather than `update`: a guarded write whose row count is the
 * answer, exactly as {@link terminate} does. `update` throws on no match, which
 * would turn an ordinary duplicate into an error.
 */
export async function claimAdHocRun(
  prisma: DbClient,
  runId: string,
  now: Date = new Date()
): Promise<ClaimedRun | undefined> {
  const claimed = await prisma.run.updateMany({
    where: {
      id: runId,
      claimedAt: null,
      status: "running" satisfies RunStatus,
      // Belt and braces with the caller, which reaches this function only for
      // an ad-hoc payload. A scheduled run must never be claimed this way: its
      // occurrence is the slot, and stamping `claimed_at` on one would imply a
      // second claim mechanism applies to it.
      scheduledFor: null,
    },
    data: { claimedAt: now },
  })

  if (claimed.count === 0) return undefined

  // Read after the claim, not before. Winning the compare-and-swap is what
  // makes this row ours to describe; reading first would widen the window in
  // which two callers both believe they have it.
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { jobId: true, startedAt: true },
  })

  return run ?? undefined
}

/**
 * Mark a run succeeded. `false` means it was already terminal.
 *
 * Transitions are enforced by `WHERE status = 'running'`, not by a CHECK — a
 * CHECK cannot see the old row. Zero rows affected means a lost race.
 */
export async function finishRun(
  prisma: DbClient,
  runId: string,
  warnings?: RunFailure
): Promise<boolean> {
  return terminate(prisma, runId, "succeeded", warnings)
}

/**
 * Keep what a run found, so it outlives the run.
 *
 * Not concurrency-sensitive and deliberately unguarded by status: the caller
 * holds the claim, and this writes an accessory record rather than a
 * transition. Throws if the run is gone — which the caller is expected to
 * treat as a warning, not as a reason to fail a run that already produced its
 * output.
 */
export async function recordRunFindings(
  prisma: DbClient,
  runId: string,
  findings: RunFindings
): Promise<Run> {
  return prisma.run.update({
    where: { id: runId },
    data: { findings: findings as Prisma.InputJsonValue },
  })
}

/** The latest run of one job, as a surface that lists briefings needs it. */
export interface RunSummary {
  id: string
  jobId: string
  status: RunStatus
  /** NULL for an ad-hoc run. Present means it filled a scheduled occurrence. */
  scheduledFor: Date | null
  startedAt: Date
  finishedAt: Date | null
  failure: RunFailure | null
}

/**
 * The most recent run of every job this user owns, at most one row per job.
 *
 * `DISTINCT ON` rather than a `findMany` per job, which would be an N+1, or a
 * `take: n` over all runs, which cannot promise it reached back far enough for
 * a job whose latest run is older than the others'. Raw SQL for the reason
 * `claimJob` and `updateJobSchedule` are raw: Prisma's model API cannot express
 * it, and the alternative is a correctness compromise rather than a stylistic
 * one.
 *
 * Joined through `jobs` on `user_id`, so — like every read the dashboard
 * makes — there is no argument that could reach another user's run. `id` breaks
 * ties on `started_at`, because two runs of one job can share an instant and an
 * unstable order would make the page flicker between them.
 */
export async function latestRunPerJob(
  prisma: DbClient,
  userId: string
): Promise<RunSummary[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string
      jobId: string
      status: string
      scheduledFor: Date | null
      startedAt: Date
      finishedAt: Date | null
      failure: RunFailure | null
    }[]
  >`
    SELECT DISTINCT ON (r.job_id)
      r.id,
      r.job_id        AS "jobId",
      r.status,
      r.scheduled_for AS "scheduledFor",
      r.started_at    AS "startedAt",
      r.finished_at   AS "finishedAt",
      r.failure
    FROM runs r
    JOIN jobs j ON j.id = r.job_id
    WHERE j.user_id = ${userId}::uuid
    ORDER BY r.job_id, r.started_at DESC, r.id DESC
  `

  return rows.map((row) => ({ ...row, status: row.status as RunStatus }))
}

/**
 * A run of this job that is still going, if there is one.
 *
 * The spend control behind the trigger: one run at a time per briefing. Takes
 * `startedAfter` rather than deciding staleness itself, because "how long is
 * too long" is a property of whatever executes the run — the Lambda timeout —
 * and this package knows nothing about that. Without the bound a run whose
 * executor died without writing a terminal status would block its briefing
 * forever, since nothing here reaps one.
 */
export async function runningRunForJob(
  prisma: DbClient,
  jobId: string,
  startedAfter: Date
): Promise<Run | undefined> {
  const run = await prisma.run.findFirst({
    where: {
      jobId,
      status: "running" satisfies RunStatus,
      startedAt: { gte: startedAfter },
    },
    orderBy: { startedAt: "desc" },
  })

  return run ?? undefined
}

/** Mark a run failed. `false` means it was already terminal. */
export async function failRun(
  prisma: DbClient,
  runId: string,
  failure?: RunFailure
): Promise<boolean> {
  return terminate(prisma, runId, "failed", failure)
}

async function terminate(
  prisma: DbClient,
  runId: string,
  status: Exclude<RunStatus, "running">,
  failure: RunFailure | undefined
): Promise<boolean> {
  const result = await prisma.run.updateMany({
    where: { id: runId, status: "running" },
    data: {
      status,
      finishedAt: new Date(),
      failure:
        failure === undefined
          ? Prisma.JsonNull
          : (failure as Prisma.InputJsonValue),
    },
  })

  return result.count > 0
}
