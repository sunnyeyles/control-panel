import type { Prisma, PrismaClient } from "./generated/prisma/client.ts"
import type { Artifact } from "./types.ts"

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Record an object key against a run.
 *
 * The CHECK on the column rejects anything with a URL scheme or a leading
 * slash, so a `https://…` handed to this method fails at the database.
 */
export async function recordArtifact(
  prisma: DbClient,
  runId: string,
  objectKey: string
): Promise<Artifact> {
  return prisma.artifact.create({
    data: { runId, objectKey },
  })
}

/** Everything one run produced, oldest first. */
export async function artifactsForRun(
  prisma: DbClient,
  runId: string
): Promise<Artifact[]> {
  return prisma.artifact.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
  })
}

/**
 * The most recent artifact from a successful run of this job — what the
 * dashboard shows as "the latest brief".
 */
export async function latestArtifactForJob(
  prisma: DbClient,
  jobId: string
): Promise<Artifact | undefined> {
  const rows = await prisma.$queryRaw<Artifact[]>`
    SELECT a.id, a.run_id AS "runId", a.object_key AS "objectKey", a.created_at AS "createdAt"
    FROM artifacts a
    JOIN runs r ON r.id = a.run_id
    WHERE r.job_id = ${jobId}::uuid AND r.status = 'succeeded'
    ORDER BY r.started_at DESC, a.created_at DESC
    LIMIT 1
  `

  return rows[0]
}
