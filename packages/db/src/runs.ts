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
