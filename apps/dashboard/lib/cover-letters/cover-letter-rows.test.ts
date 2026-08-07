import {
  StorageUnavailableError,
  type CoverLetterStore,
  type StoredCoverLetter,
} from "@workspace/user-storage"
import { describe, expect, it } from "vitest"

import { coverLetterRowsFor, listCoverLetters } from "./cover-letter-rows"

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

describe("listCoverLetters", () => {
  it("asks once for the whole user, not once per Posting", async () => {
    const postingIds = Array.from({ length: 25 }, (_, index) =>
      String(index).padStart(16, "0")
    )
    const result = storeOf(postingIds.map(listed))

    const found = await listCoverLetters(USER_ID, result.store)

    expect(result.listedFor).toEqual([USER_ID])
    expect(found).toHaveLength(25)
  })

  it("takes no posting ids, so it need not wait for the postings query", () => {
    // Not a style assertion. The page starts this request alongside
    // `listPostings` precisely because it cannot depend on its result, and a
    // second parameter here would be the thing that quietly reintroduced the
    // dependency. `listCoverLetters.length` counts the declared parameters.
    expect(listCoverLetters).toHaveLength(2)
  })

  it("reports an unavailable store instead of showing every Posting undrafted", async () => {
    const unavailable = new StorageUnavailableError("access denied")
    const result = storeOf(unavailable)

    await expect(listCoverLetters(USER_ID, result.store)).rejects.toBe(
      unavailable
    )
  })
})

describe("coverLetterRowsFor", () => {
  it("returns only the current page's Postings", () => {
    const visible = "0f1e2d3c4b5a6978"
    const elsewhere = "aaaaaaaaaaaaaaaa"

    const rows = coverLetterRowsFor(
      [listed(visible), listed(elsewhere)],
      [visible]
    )

    expect(rows.map((row) => row.postingId)).toEqual([visible])
  })

  it("omits a Posting with no drafted letter", () => {
    const drafted = "0f1e2d3c4b5a6978"
    const undrafted = "aaaaaaaaaaaaaaaa"

    const rows = coverLetterRowsFor([listed(drafted)], [drafted, undrafted])

    expect(rows.map((row) => row.postingId)).toEqual([drafted])
  })

  it("returns only the two fields the table renders", () => {
    const postingId = "0f1e2d3c4b5a6978"

    const rows = coverLetterRowsFor([listed(postingId)], [postingId])

    // Not `displayName` and not `filename`: a listing carries no object
    // metadata, so both are derived from the Posting in `posting-detail.tsx`.
    expect(rows).toEqual([
      { postingId, draftedAt: expect.stringContaining("1 Aug 2026") },
    ])
  })

  it("is empty for an empty page, however much has been drafted", () => {
    // The listing still happened — it is started before the postings are known,
    // and `listCoverLetters` is where that trade is documented. What must not
    // happen is a letter for some other page crossing the RSC boundary.
    expect(coverLetterRowsFor([listed("0f1e2d3c4b5a6978")], [])).toEqual([])
  })
})
