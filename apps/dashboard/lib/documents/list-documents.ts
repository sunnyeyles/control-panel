import {
  listDocumentsForUser,
  type DocumentType,
  type PrismaClient,
} from "@workspace/db"

import { formatDocumentFile } from "./document-ref"

/** One row of the documents table. Everything is already display-ready. */
export interface DocumentSummary {
  resumeId: string
  extension: string
  /** What the user called the file. */
  displayName: string
  documentType: DocumentType
  size: number
  uploadedAt: Date
  /** `{resumeId}{extension}` — the download route's path segment. */
  file: string
}

/**
 * Every document a user has, newest first.
 *
 * One indexed query. It used to be an S3 `ListObjectsV2` plus a `HeadObject`
 * per document, eight at a time, because the filename and the Document Type
 * lived in S3 user metadata and `ListObjectsV2` does not carry user metadata at
 * all — and this function is reached from `/documents`, from `/jobs/letters`, and
 * from every cover-letter, tailored-resume and suggest-criteria run. `documents`
 * in Postgres is what removed it.
 *
 * The bucket is no longer consulted here, and nothing on this path can fail
 * per-row: a document either has a row or it does not. That is also the one
 * thing to know when reading this against the git history — the degraded-row
 * handling and its logging are gone because the failure they degraded no longer
 * exists, not because it was decided to be unimportant.
 *
 * ⚠️ **`docType` is narrowed by the database, not here.** The column is `NOT
 * NULL` with a CHECK naming the six values, so the cast is the type catching up
 * with a constraint Postgres already enforces rather than an assumption. A
 * value that failed the CHECK could not have been written.
 */
export async function listDocuments(
  userId: string,
  prisma: PrismaClient
): Promise<DocumentSummary[]> {
  const rows = await listDocumentsForUser(prisma, userId)

  return rows.map((row) => ({
    resumeId: row.id,
    extension: row.extension,
    displayName: row.filename,
    documentType: row.docType as DocumentType,
    size: row.byteSize,
    uploadedAt: row.uploadedAt,
    file: formatDocumentFile({ resumeId: row.id, extension: row.extension }),
  }))
}
