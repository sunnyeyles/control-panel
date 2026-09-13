import { devDocuments } from "@/lib/dev/fixtures"
import type { Board, Document } from "@workspace/db"

/**
 * Plain data holder for the in-memory store. No domain logic — each delegate
 * reads and mutates these directly.
 */
export interface DevStore {
  readonly documents: Document[]
  board: Board | undefined
}

export function createDevStore(): DevStore {
  return {
    documents: devDocuments(),
    /** No fixture — the dev whiteboard starts empty. */
    board: undefined,
  }
}
