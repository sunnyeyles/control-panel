import {
  listDocumentsForUser,
  type DocumentType,
  type PrismaClient,
} from "@workspace/db"

import { formatDocumentFile } from "./document-ref"

/** One row of the documents table. Everything is already display-ready. */
export interface DocumentSummary {
  documentId: string
  extension: string
  /** What the user called the file. */
  displayName: string
  documentType: DocumentType
  size: number
  uploadedAt: Date
  /** `{documentId}{extension}` — the download route's path segment. */
  file: string
}

/**
 * Every document a user has, newest first.
 *
 * One indexed query. It used to be a `ListObjectsV2` plus a `HeadObject` per
 * document, because the filename and Document Type lived in S3 user metadata,
 * which a listing does not carry. The bucket is no longer consulted, so nothing
 * here can fail per-row — which is why the old degraded-row handling is gone.
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
    documentId: row.id,
    extension: row.extension,
    displayName: row.filename,
    documentType: row.docType as DocumentType,
    size: row.byteSize,
    uploadedAt: row.uploadedAt,
    file: formatDocumentFile({ documentId: row.id, extension: row.extension }),
  }))
}
