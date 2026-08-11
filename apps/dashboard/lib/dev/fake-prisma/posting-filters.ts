import type { PostingFilters } from "@workspace/db"
import type { DevStore } from "./store"
import type { ByUserId, UpsertPostingFilters } from "./query-types"

/**
 * The account-wide title filter. Read on every `/jobs` render — it decides
 * which rows that page shows — and written from `/jobs/schedules`.
 *
 * `findUnique` ignores the `select` `titleExclusions()` sends, which is
 * safe in the one direction that matters: the answer is a superset of the
 * question and no caller can tell. `projectPosting` had to stop doing that
 * because its `select` names a *relation*; this one names a column.
 */
export function createPostingFiltersDelegate(store: DevStore) {
  return {
    findUnique: async (query: ByUserId) =>
      findPostingFilters(store, query.where.userId),
    upsert: async (query: UpsertPostingFilters) =>
      upsertPostingFilters(store, query),
  }
}

/**
 * `null` for a user who has never saved one, exactly as
 * findCoverLetterInstructions answers: `titleExclusions()` in
 * `@workspace/db` turns that into `[]`, and the distinction between "never
 * set" and "set to nothing" stays available to anything that wants it.
 */
function findPostingFilters(
  store: DevStore,
  userId: string
): PostingFilters | null {
  return store.postingFilters.find((row) => row.userId === userId) ?? null
}

/**
 * A save is the whole list, not a patch of it — so unlike the cover-letter
 * upsert there is nothing to merge with what was there: an empty list is a
 * legitimate value and must not be filled in from the previous one.
 */
function upsertPostingFilters(
  store: DevStore,
  query: UpsertPostingFilters
): PostingFilters {
  const { userId } = query.where
  const existing = findPostingFilters(store, userId)
  const written = existing ? query.update : query.create

  const row: PostingFilters = {
    userId,
    titleExclusions: [...written.titleExclusions],
    updatedAt: new Date(),
  }

  if (existing) return Object.assign(existing, row)

  store.postingFilters.push(row)
  return row
}
