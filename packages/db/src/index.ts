/**
 * Postgres for scheduling and provenance — jobs, their runs, and pointers to
 * what those runs produced.
 *
 * Compose a client once, at the composition root:
 *
 * ```ts
 * const prisma = createPrismaClient()
 * try {
 *   for (const job of await dueJobs(prisma)) {
 *     const slot = await claimJob(prisma, job)
 *     if (!slot) continue
 *     // …run it…
 *     await finishRun(prisma, slot.runId)
 *   }
 * } finally {
 *   await prisma.$disconnect()
 * }
 * ```
 *
 * Domain helpers (`claimJob`, `createJob`, …) own the concurrency and schedule
 * invariants. Everything else is ordinary Prisma Client usage against the
 * generated models.
 *
 * Individual modules are importable directly:
 * `@workspace/db/schedule` gets `computeNextRunAt` without pulling in the
 * driver at all.
 */
export { createPrismaClient, type PrismaClient } from "./client.ts"

export { Prisma } from "./generated/prisma/client.ts"

export {
  readDatabaseConfig,
  DATABASE_URL,
  DATABASE_URL_UNPOOLED,
  type DatabaseConfig,
} from "./config.ts"

export { ensureUserForAuth } from "./users.ts"

export {
  coverLetterInstructions,
  saveCoverLetterInstructions,
} from "./cover-letter-instructions.ts"

export {
  claimJob,
  createJob,
  dueJobs,
  pauseJob,
  resumeJob,
  updateJobSchedule,
  type ClaimedSlot,
  type DueJob,
  type NewJob,
} from "./jobs.ts"

export {
  claimAdHocRun,
  failRun,
  finishRun,
  latestRunPerJob,
  recordRunFindings,
  runningRunForJob,
  startAdHocRun,
  type ClaimedRun,
  type RunSummary,
} from "./runs.ts"

export {
  artifactsForRun,
  latestArtifactForJob,
  recordArtifact,
} from "./artifacts.ts"

export { computeNextRunAt, isValidSchedule } from "./schedule.ts"

export type {
  Artifact,
  CoverLetterInstructions,
  Job,
  JobConfig,
  Run,
  RunFailure,
  RunFindings,
  RunStatus,
  User,
} from "./types.ts"

export {
  DbError,
  InvalidScheduleError,
  isDbError,
  isUniqueViolation,
  type DbErrorCode,
} from "./errors.ts"
