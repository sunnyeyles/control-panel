import {
  StorageUnavailableError,
  type CoverLetterStore,
  type StoredCoverLetter,
} from "@workspace/user-storage"
import { describe, expect, it } from "vitest"

import { loadCoverLetterRows } from "./cover-letter-rows"

const USER_ID = "11111111-2222-4333-8444-555555555555"

/**
 * A letter as a **listing** returns it: no provenance, and `draftedAt` taken
 * from the object's write time. That is what `toStoredCoverLetter` produces
 * from a `ListObjectsV2` result, and building the fixture any richer would let
 * this suite pass over a read path the real store cannot supply.
 */
function listed(postingId: string): StoredCoverLetter {
  return {
    key: `prod/${USER_ID}/cover-letters/${postingId}.md`,
    userId: USER_ID,
    postingId,
    size: 2048,
    draftedAt: new Date("2026-08-01T04:15:00Z"),
    provenance: {},
  }
}

function storeOf(letters: StoredCoverLetter[] | Error) {
  const listedFor: string[] = []

  const store: CoverLetterStore = {
    put: async () => {
      throw new Error("not used")
    },
    get: async () => {
      throw new Error("not used")
    },
    head: async () => {
      throw new Error("not used — the page reads a listing, never a head")
    },
    delete: async () => {},
    list: async (userId) => {
      listedFor.push(userId)
      if (letters instanceof Error) throw letters
      return letters
    },
  }

  return { store, listedFor }
}

describe("loadCoverLetterRows", () => {
  it("asks once for the whole user, not once per Posting", async () => {
    const postingIds = Array.from({ length: 25 }, (_, index) =>
      String(index).padStart(16, "0")
    )
    const result = storeOf(postingIds.map(listed))

    const rows = await loadCoverLetterRows(USER_ID, postingIds, result.store)

    expect(result.listedFor).toEqual([USER_ID])
    expect(rows).toHaveLength(25)
  })

  it("returns only the current page's Postings", async () => {
    const visible = "0f1e2d3c4b5a6978"
    const elsewhere = "aaaaaaaaaaaaaaaa"
    const result = storeOf([listed(visible), listed(elsewhere)])

    const rows = await loadCoverLetterRows(USER_ID, [visible], result.store)

    expect(rows.map((row) => row.postingId)).toEqual([visible])
  })

  it("omits a Posting with no drafted letter", async () => {
    const drafted = "0f1e2d3c4b5a6978"
    const undrafted = "aaaaaaaaaaaaaaaa"
    const result = storeOf([listed(drafted)])

    const rows = await loadCoverLetterRows(
      USER_ID,
      [drafted, undrafted],
      result.store
    )

    expect(rows.map((row) => row.postingId)).toEqual([drafted])
  })

  it("returns only the two fields the table renders", async () => {
    const postingId = "0f1e2d3c4b5a6978"
    const result = storeOf([listed(postingId)])

    const rows = await loadCoverLetterRows(USER_ID, [postingId], result.store)

    // Not `displayName` and not `filename`: a listing carries no object
    // metadata, so both are derived from the Posting in `posting-detail.tsx`.
    expect(rows).toEqual([
      { postingId, draftedAt: expect.stringContaining("1 Aug 2026") },
    ])
  })

  it("reports an unavailable store instead of showing every Posting undrafted", async () => {
    const unavailable = new StorageUnavailableError("access denied")
    const result = storeOf(unavailable)

    await expect(
      loadCoverLetterRows(USER_ID, ["0f1e2d3c4b5a6978"], result.store)
    ).rejects.toBe(unavailable)
  })

  it("costs no request at all when the page is empty", async () => {
    const result = storeOf([])

    await expect(
      loadCoverLetterRows(USER_ID, [], result.store)
    ).resolves.toEqual([])
    expect(result.listedFor).toEqual([])
  })
})
