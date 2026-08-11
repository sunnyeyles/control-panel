import type { Board } from "@workspace/db"
import type { DevStore } from "./store"
import type { ByUserId, UpsertBoard } from "./query-types"

/**
 * The whiteboard, which starts empty under the flag and stays wherever the
 * session leaves it. No fixture: a canned diagram is not what anyone is
 * checking on this page, and an empty canvas is the state the feature has
 * to work from anyway.
 */
export function createWhiteboardDelegate(store: DevStore) {
  return {
    findUnique: async (query: ByUserId) => findBoard(store, query.where.userId),
    upsert: async (query: UpsertBoard) => upsertBoard(store, query),
  }
}

function findBoard(store: DevStore, userId: string): Board | null {
  return store.board?.userId === userId ? store.board : null
}

/**
 * Replaces the snapshot whole, as the real upsert does. A board is a picture
 * rather than a patch of one, so there is nothing to merge.
 */
function upsertBoard(store: DevStore, query: UpsertBoard): Board {
  const { userId } = query.where
  const snapshot = findBoard(store, userId)
    ? query.update.snapshot
    : query.create.snapshot

  store.board = {
    userId,
    snapshot: snapshot as Board["snapshot"],
    updatedAt: new Date(),
  }
  return store.board
}
