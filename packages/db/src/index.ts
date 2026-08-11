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

export { ensureUserForAuth } from "./users.ts"

export {
  coverLetterInstructions,
  saveCoverLetterInstructions,
} from "./cover-letter-instructions.ts"

export {
  postingFilters,
  savePostingFilters,
  titleExclusions,
} from "./posting-filters.ts"

export { loadBoard, saveBoard } from "./boards.ts"

export {
  claimJob,
  createJob,
  dueJobs,
  findJob,
  pauseJob,
  resumeJob,
  updateJobConfig,
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
} from "./runs.ts"

export { recordArtifact } from "./artifacts.ts"

export {
  deleteDocument,
  DOCUMENT_TYPES,
  findDocument,
  listDocumentsForUser,
  recordDocument,
  type NewDocument,
} from "./documents.ts"

export {
  countUnmatchedPostings,
  deletePostings,
  listPostingPage,
  listUnmatchedPostingIds,
  ownedPostingIds,
  postingIdentities,
  postingPayload,
  POSTING_STATUSES,
  recordLinkedPosting,
  recordPostingMatch,
  recordPostings,
  setPostingStatus,
  type LinkedPosting,
  type NewPosting,
  type PostingDirection,
  type PostingIdentityRow,
  type PostingListPage,
  type PostingListRow,
  type PostingMatchRow,
  type PostingMatchWrite,
  type PostingOrder,
  type PostingPageQuery,
  type SeenPostings,
  type StoredPostingPayload,
} from "./postings.ts"

export { computeNextRunAt } from "./schedule.ts"

export type {
  Artifact,
  Board,
  CoverLetterInstructions,
  Document,
  DocumentType,
  Job,
  JobConfig,
  Posting,
  PostingFilters,
  PostingStatus,
  Run,
  RunFailure,
} from "./types.ts"

export { InvalidScheduleError, isDbError, isUniqueViolation } from "./errors.ts"
