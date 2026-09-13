/**
 * Postgres for the records a person writes into — the auth identity link,
 * uploaded Document metadata, and the whiteboard snapshot.
 *
 * Compose a client once, at the composition root:
 *
 * ```ts
 * const prisma = createPrismaClient()
 * const user = await ensureUserForAuth(prisma, authUserId)
 * const documents = await listDocumentsForUser(prisma, user.id)
 * ```
 *
 * Domain helpers own the invariants the model API cannot express alone — the
 * race-safe identity link, and the `user_id` filter that is the ownership check
 * on a Document. Everything else is ordinary Prisma Client usage against the
 * generated models.
 */
export { createPrismaClient, type PrismaClient } from "./client.ts"

export { ensureUserForAuth } from "./users.ts"

export { loadBoard, saveBoard } from "./boards.ts"

export {
  deleteDocument,
  DOCUMENT_TYPES,
  findDocument,
  listDocumentsForUser,
  recordDocument,
  type NewDocument,
} from "./documents.ts"

export type { Board, Document, DocumentType } from "./types.ts"
