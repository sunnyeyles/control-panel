import type {
  Board as PrismaBoard,
  Document as PrismaDocument,
  User as PrismaUser,
} from "./generated/prisma/client.ts"

/** Domain aliases over generated Prisma model types. */

/**
 * What the user says a Document is.
 *
 * Text plus a CHECK rather than a Postgres enum. `other` is not filler —
 * without it a document that is none of the other five gets mislabelled.
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
export type Document = PrismaDocument
export type Board = PrismaBoard
