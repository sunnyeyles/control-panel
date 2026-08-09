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
 * run, `claimed.startedAt` for a manual one — never the wall clock. The
 * brief's S3 partition day derives from the same instant, and the cumulative
 * posting record must agree with it: a 23:30 slot that finishes after
 * midnight must not claim it found something the following day. The clock
 * says when the work happened; the occurrence says which run it was.
 *
 * The two call sites used to each spell out these closures with that
 * paragraph beside them; the factory exists so the choice of instant is made
 * once per run, in one argument, instead of being re-derived per callback.
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
