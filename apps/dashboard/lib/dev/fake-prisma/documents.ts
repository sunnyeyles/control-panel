import type { Document } from "@workspace/db"
import type { DevStore } from "./store"
import type { DocumentsForUser, DocumentWhere } from "./query-types"

/**
 * ⚠️ Both lookups are scoped by owner because in the real thing that scoping
 * *is* the ownership check — `findDocument` and `deleteDocument` have no other
 * one. Answering from the id alone would let that scoping be dropped unnoticed.
 */
export function createDocumentDelegate(store: DevStore) {
  return {
    findMany: async (query: DocumentsForUser) =>
      findManyDocuments(store, query.where.userId),
    findFirst: async (query: { where: DocumentWhere }) =>
      findDocument(store, query.where),
    create: async (query: { data: Document }) =>
      createDocument(store, query.data),
    deleteMany: async (query: { where: DocumentWhere }) =>
      deleteDocuments(store, query.where),
  }
}

/**
 * One user's Documents, newest first.
 *
 * The real query's order, restated rather than ignored: `loadCandidateBackground`
 * picks "the newest document labelled resume" by taking the first match out of
 * it, so insertion order would make that choice look arbitrary here and correct
 * in production.
 */
function findManyDocuments(store: DevStore, userId: string): Document[] {
  return store.documents
    .filter((document) => document.userId === userId)
    .sort(
      (left, right) =>
        right.uploadedAt.getTime() - left.uploadedAt.getTime() ||
        right.id.localeCompare(left.id)
    )
}

function findDocument(store: DevStore, where: DocumentWhere): Document | null {
  return (
    store.documents.find(
      (document) =>
        document.userId === where.userId &&
        (where.id === undefined || document.id === where.id)
    ) ?? null
  )
}

function createDocument(store: DevStore, data: Document): Document {
  const row: Document = { ...data, uploadedAt: data.uploadedAt ?? new Date() }
  store.documents.push(row)
  return row
}

/**
 * Splices out of the backing array rather than rebuilding it, for the reason
 * deletePostings gives: the field is `readonly` and every other method reads
 * through it.
 */
function deleteDocuments(
  store: DevStore,
  where: DocumentWhere
): { count: number } {
  let removed = 0

  for (let index = store.documents.length - 1; index >= 0; index -= 1) {
    const row = store.documents[index]

    if (
      row &&
      row.userId === where.userId &&
      (where.id === undefined || row.id === where.id)
    ) {
      store.documents.splice(index, 1)
      removed += 1
    }
  }

  return { count: removed }
}
