import type { CoverLetterInstructions } from "@workspace/db"
import type { DevStore } from "./store"
import type { ByUserId, UpsertCoverLetterInstructions } from "./query-types"

export function createInstructionsDelegate(store: DevStore) {
  return {
    findUnique: async (query: ByUserId) =>
      findCoverLetterInstructions(store, query.where.userId),
    upsert: async (query: UpsertCoverLetterInstructions) =>
      upsertCoverLetterInstructions(store, query),
  }
}

/**
 * `null`, not an empty row, for a user who has never saved: the caller draws
 * a distinction between "no preference was ever expressed" and "it was, and
 * it is empty", and answering `{ instructions: "" }` here would erase it.
 */
function findCoverLetterInstructions(
  store: DevStore,
  userId: string
): CoverLetterInstructions | null {
  return (
    store.coverLetterInstructions.find((row) => row.userId === userId) ?? null
  )
}

/**
 * Create and update in the one call, as Prisma does — and the created row
 * lives in the same array as the fixture, so the save survives the redirect
 * after it and a restart puts the fixture back.
 */
function upsertCoverLetterInstructions(
  store: DevStore,
  query: UpsertCoverLetterInstructions
): CoverLetterInstructions {
  const { userId } = query.where
  const existing = findCoverLetterInstructions(store, userId)
  const written = existing ? query.update : query.create

  const row: CoverLetterInstructions = {
    userId,
    instructions: written.instructions ?? existing?.instructions ?? "",
    exampleLetter: written.exampleLetter ?? existing?.exampleLetter ?? "",
    updatedAt: new Date(),
  }

  if (existing) return Object.assign(existing, row)

  store.coverLetterInstructions.push(row)
  return row
}
