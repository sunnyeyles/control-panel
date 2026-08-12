import type { Document, DocumentType, PrismaClient } from "@workspace/db"

/**
 * A `documents` table, for tests.
 *
 * Here rather than restated in each suite because four of them need the same
 * thing: `listDocuments` and `findDocument` read Postgres, so any test of a path
 * that reaches a document must supply rows as well as bytes.
 * `lib/dev/fake-prisma.ts` is deliberately not reused — it is the
 * `DEV_AUTH_BYPASS=1` fake, seeded from fixed fixtures and answering for one
 * hardcoded user.
 *
 * ⚠️ **`userId` is honoured on both reads.** In the real thing that filter *is*
 * the ownership check — `findDocument` and `deleteDocument` have no second one
 * underneath — so a double answering from the id alone would let the scoping be
 * dropped with every test still green.
 */

/** One row, with everything a test does not care about defaulted. */
export interface FakeDocumentRow {
  id: string
  extension: string
  filename?: string
  docType?: DocumentType
  byteSize?: number
  uploadedAt?: Date
}

const EPOCH = new Date("2026-01-01T00:00:00.000Z")

export function toFakeDocument(
  userId: string,
  row: FakeDocumentRow,
  index = 0
): Document {
  return {
    id: row.id,
    userId,
    extension: row.extension,
    filename: row.filename ?? `${row.id}${row.extension}`,
    docType: row.docType ?? "other",
    byteSize: row.byteSize ?? 0,
    // Descending by position when unset, so "newest first" is observable
    // without every caller inventing timestamps.
    uploadedAt: row.uploadedAt ?? new Date(EPOCH.getTime() - index * 1000),
  }
}

/**
 * The four calls `@workspace/db`'s document helpers make, and nothing else.
 *
 * `rows` is read live rather than copied, so a suite can add to the array after
 * building the client — which is what lets a fake store's `add()` stay the one
 * place a document is registered.
 */
export function fakeDocumentDb(userId: string, rows: Document[]): PrismaClient {
  const mine = (id?: string) =>
    rows.filter((row) => row.userId === userId && (!id || row.id === id))

  return {
    document: {
      findMany: async () =>
        [...mine()].sort(
          (left, right) =>
            right.uploadedAt.getTime() - left.uploadedAt.getTime() ||
            right.id.localeCompare(left.id)
        ),
      findFirst: async (query: { where: { id?: string; userId: string } }) =>
        (query.where.userId === userId ? mine(query.where.id)[0] : undefined) ??
        null,
      create: async (query: { data: Document }) => {
        rows.push(query.data)
        return query.data
      },
      deleteMany: async (query: { where: { id?: string; userId: string } }) => {
        const doomed = new Set(
          query.where.userId === userId
            ? mine(query.where.id).map((row) => row.id)
            : []
        )

        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (doomed.has(rows[index]?.id ?? "")) rows.splice(index, 1)
        }

        return { count: doomed.size }
      },
    },
  } as unknown as PrismaClient
}

/**
 * Two partial clients as one.
 *
 * An action holds a single `PrismaClient`, so a suite faking both its own tables
 * and `documents` needs one object with both delegates. A shallow merge is right
 * only while the two name no table in common — keep them disjoint.
 */
export function mergeClients(...clients: PrismaClient[]): PrismaClient {
  return Object.assign({}, ...clients) as PrismaClient
}
