import type {
  Artifact as PrismaArtifact,
  Board as PrismaBoard,
  CoverLetterInstructions as PrismaCoverLetterInstructions,
  Document as PrismaDocument,
  Job as PrismaJob,
  Posting as PrismaPosting,
  PostingFilters as PrismaPostingFilters,
  Run as PrismaRun,
  User as PrismaUser,
} from "./generated/prisma/client.ts"

/**
 * Domain aliases over generated Prisma model types.
 *
 * `config` / `failure` stay JSON at the database; callers that interpret them
 * narrow with their own schemas (see the worker's `JobSearchConfigSchema`).
 */

/** Anything the pipeline puts on a job. The platform never reads inside it. */
export type JobConfig = Record<string, unknown>

/**
 * Per-source failure detail, or the warnings from a run that otherwise
 * succeeded.
 */
export type RunFailure = Record<string, unknown>

/**
 * What a run found, as its producer validated it. Opaque here: the platform
 * stores it beside the run and never reads inside it, exactly as it treats
 * `config` and `failure`.
 */
export type RunFindings = Record<string, unknown>

/**
 * `running` → `succeeded` | `failed`, and both are terminal.
 *
 * "Succeeded with warnings" is `succeeded` with a non-empty `failure`.
 */
export type RunStatus = "running" | "succeeded" | "failed"

/**
 * The Posting as its producer validated it. Opaque here, exactly as
 * `RunFindings` and `JobConfig` are — the four projected columns beside it are
 * what this package sorts and filters on.
 */
export type PostingPayload = Record<string, unknown>

/**
 * `new` on discovery, and the other three only ever set by a person.
 *
 * **Who acts is not uniform.** `applied` and `not-interested` are the user's
 * decisions about the advertisement; `rejected` is the *employer's* answer, so
 * it can only follow `applied`. Nothing enforces that ordering, and nothing
 * should — a person may change their mind in any direction, including back to
 * `new`. Nothing in the pipeline may move a Posting off a user's value, which
 * is why `recordPostings` omits `status` from its `DO UPDATE SET`.
 *
 * Text plus a CHECK rather than a Postgres enum, mirroring {@link RunStatus};
 * hyphenated per `documents_doc_type_check`. Type-only, and it erases — the
 * runtime list is `POSTING_STATUSES` in `postings.ts`.
 */
export type PostingStatus = "new" | "applied" | "not-interested" | "rejected"

/**
 * What the user says a Document is.
 *
 * Text plus a CHECK rather than a Postgres enum, mirroring {@link RunStatus}
 * and {@link PostingStatus}. `other` is not filler — without it a document that
 * is none of the other five gets mislabelled.
 *
 * ⚠️ **These are not storage *kinds*.** A kind in `@workspace/user-storage` is
 * a key segment, an S3 tag and a file-type allowlist at once; all six of these
 * live on the `resumes` shelf.
 *
 * Type-only, and it erases — the runtime list is `DOCUMENT_TYPES` in
 * `documents.ts`, which is what lets a client component import the type.
 */
export type DocumentType =
  | "resume"
  | "cover-letter"
  | "portfolio"
  | "reference"
  | "certification"
  | "other"

export type User = PrismaUser
export type Job = PrismaJob
export type Run = PrismaRun
export type Artifact = PrismaArtifact
export type Posting = PrismaPosting
export type Document = PrismaDocument
export type CoverLetterInstructions = PrismaCoverLetterInstructions
export type PostingFilters = PrismaPostingFilters
export type Board = PrismaBoard
