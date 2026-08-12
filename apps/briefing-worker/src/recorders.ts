import type { Findings } from "@workspace/agents"
import {
  recordArtifact,
  recordPostings,
  recordRunFindings,
  type Artifact,
  type NewPosting,
  type PrismaClient,
} from "@workspace/db"

/** The three `runBriefing` callbacks that write through Prisma. */
export interface PrismaRecorders {
  recordArtifact: (runId: string, objectKey: string) => Promise<Artifact>
  recordFindings: (runId: string, findings: Findings) => Promise<unknown>
  recordPostings: (runId: string, postings: NewPosting[]) => Promise<unknown>
}

/**
 * The recorder wiring both entry points hand to `runBriefing`, built once.
 *
 * `seenAt` is **this run's occurrence** — `slot.scheduledFor` for a scheduled
 * run, `claimed.startedAt` for a manual one — never the wall clock. The brief's
 * S3 partition day derives from the same instant and the posting record must
 * agree: a 23:30 slot finishing after midnight must not claim it found
 * something the following day. The factory exists so that choice is made once
 * per run rather than re-derived per callback.
 */
export function prismaRecorders(
  prisma: PrismaClient,
  run: { userId: string; seenAt: Date }
): PrismaRecorders {
  return {
    recordArtifact: (runId, objectKey) =>
      recordArtifact(prisma, runId, objectKey),
    recordFindings: (runId, findings) =>
      recordRunFindings(prisma, runId, findings),
    recordPostings: (runId, postings) =>
      recordPostings(prisma, {
        userId: run.userId,
        runId,
        seenAt: run.seenAt,
        postings,
      }),
  }
}
