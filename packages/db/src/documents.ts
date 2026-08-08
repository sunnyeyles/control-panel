import type { Prisma, PrismaClient } from "./generated/prisma/client.ts"
import type { Document, DocumentType } from "./types.ts"

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * The six Document Types, as a value.
 *
 * Lives here rather than in `types.ts`, which is type-only and erases: a
 * runtime array there would make that module emit, and every consumer that
 * imports a type from it would start pulling in a value — including the
 * dashboard's label map, which is reached from a client component.
 *
 * `satisfies` rather than a hand-kept copy, so adding a type to
 * {@link DocumentType} without adding it here fails to compile. The CHECK on
 * `documents.doc_type` is the third copy and the only one the database
 * enforces; all three have to move together.
 */
export const DOCUMENT_TYPES = [
  "resume",
  "cover-letter",
  "portfolio",
  "reference",
  "certification",
  "other",
] as const satisfies readonly DocumentType[]

/** A Document on its way in, once its bytes are already in the bucket. */
export interface NewDocument {
  /**
   * The uuid the caller minted, which is *also* the S3 key segment. Not
   * generated here: the object is written first, so the id has to exist before
   * this row does. See the column comment in `0007_documents`.
   */
  id: string
  userId: string
  /** Dot-prefixed and lowercase, as a CHECK on the column enforces. */
  extension: string
  /** What the user called the file, unmangled. */
  filename: string
  docType: DocumentType
  byteSize: number
}

/**
 * Record a Document whose bytes are already stored.
 *
 * ⚠️ **Call this *after* the object is written, never before.** A failed upload
 * following a successful insert leaves a row whose download 404s and which the
 * user can see; a failed insert following a successful upload leaves an object
 * nothing points at, which is invisible, costs a few kilobytes, and can be
 * deleted on the way out. Only one of those two is recoverable.
 */
export async function recordDocument(
  prisma: DbClient,
  document: NewDocument,
  now: Date = new Date()
): Promise<Document> {
  return prisma.document.create({ data: { ...document, uploadedAt: now } })
}

/**
 * One user's Documents, newest first.
 *
 * The order is the index's, not a sort in memory, and it is tie-broken on `id`
 * so two uploads sharing a timestamp cannot swap places between renders. There
 * is no pagination: the row count is bounded by what one person uploaded.
 */
export async function listDocumentsForUser(
  prisma: DbClient,
  userId: string
): Promise<Document[]> {
  return prisma.document.findMany({
    where: { userId },
    orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
  })
}

/**
 * One Document, or `undefined` if this user has no such document.
 *
 * **`userId` in the `where` is the ownership check**, not a shortcut past one,
 * and it is the same argument {@link deleteDocument} and `setPostingStatus`
 * make: one statement closes the TOCTOU window a load-then-compare would leave
 * open, and the caller gets one answer for "no such document" and "someone
 * else's" rather than a distinction that tells a stranger the row exists.
 *
 * The id reaching here came out of a URL or a form, so this is the only thing
 * standing between it and another user's bytes.
 */
export async function findDocument(
  prisma: DbClient,
  userId: string,
  id: string
): Promise<Document | undefined> {
  const row = await prisma.document.findFirst({ where: { id, userId } })

  return row ?? undefined
}

/**
 * Remove a Document. `false` means this user has no such document.
 *
 * `deleteMany` rather than `delete` for the reason `deletePostings` gives: a
 * guarded write whose row count is the answer. `delete` throws on no match,
 * which would turn an ordinary miss into an error.
 *
 * Deleting the row does not delete the object — the caller does that next, and
 * this order is deliberate. A row removed with the object still present is an
 * orphan in the bucket, which is invisible and collectable; an object removed
 * with the row still present is a document the user can see and cannot open.
 */
export async function deleteDocument(
  prisma: DbClient,
  userId: string,
  id: string
): Promise<boolean> {
  const deleted = await prisma.document.deleteMany({ where: { id, userId } })

  return deleted.count > 0
}
