import type {
  Artifact as PrismaArtifact,
  CoverLetterInstructions as PrismaCoverLetterInstructions,
  Document as PrismaDocument,
  Job as PrismaJob,
  Posting as PrismaPosting,
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
 * `new` on discovery, and the other two only ever set by a person.
 *
 * Text plus a CHECK rather than a Postgres enum, mirroring {@link RunStatus}.
 * Nothing in the pipeline may move a Posting off the value a user chose: the
 * `DO UPDATE SET` list in `recordPostings` omits `status` for exactly that
 * reason, and no transition is enforced beyond the CHECK because every one of
 * them is legal.
 *
 * Type-only, and it erases. The runtime list is `POSTING_STATUSES` in
 * `postings.ts`; this file must stay importable without pulling in a value.
 */
export type PostingStatus = "new" | "applied" | "rejected"

/**
 * What the user says a Document is.
 *
 * Text plus a CHECK rather than a Postgres enum, mirroring {@link RunStatus}
 * and {@link PostingStatus}. `other` is not filler: without it a document that
 * is none of the other five has to be mislabelled as one of them, and a label
 * nobody trusts is worse than no label.
 *
 * These are not storage *kinds*. A kind — `resumes`, `briefs`,
 * `cover-letters`, `tailored-resumes` in `@workspace/user-storage` — is a key
 * segment, an S3 object tag and a file-type allowlist at once, and every one of
 * these six wants the same three. They all live on the `resumes` shelf.
 *
 * Type-only, and it erases. The runtime list is `DOCUMENT_TYPES` in
 * `documents.ts`; this file must stay importable without pulling in a value,
 * which is what lets a client component import the type for a label map.
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
