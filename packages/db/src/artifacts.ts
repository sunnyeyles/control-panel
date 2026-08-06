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
