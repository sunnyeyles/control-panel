import {
  ObjectNotFoundError,
  StorageUnavailableError,
  type CoverLetterRef,
  type CoverLetterStore,
  type StoredCoverLetter,
} from "@workspace/user-storage"
import { describe, expect, it } from "vitest"

import { loadCoverLetterRows } from "./cover-letter-rows"

const USER_ID = "11111111-2222-4333-8444-555555555555"

function stored(
  postingId: string,
  extra: Partial<StoredCoverLetter> = {}
): StoredCoverLetter {
  return {
    key: `prod/${USER_ID}/cover-letters/${postingId}.md`,
    userId: USER_ID,
    postingId,
    size: 2048,
    draftedAt: new Date("2026-08-01T04:15:00Z"),
    provenance: {},
    ...extra,
  }
}

function storeOf(heads: Record<string, StoredCoverLetter | Error>) {
  const headed: CoverLetterRef[] = []

  const store: CoverLetterStore = {
    put: async () => {
      throw new Error("not used")
    },
    get: async () => {
      throw new Error("not used")
    },
    head: async (ref) => {
      headed.push(ref)
      const result = heads[`${ref.userId}/${ref.postingId}`]
      if (result instanceof Error) throw result
      if (!result) throw new Error(`no head for ${ref.userId}/${ref.postingId}`)
      return result
    },
    delete: async () => {},
  }

  return { store, headed }
}

describe("loadCoverLetterRows", () => {
  it("reads only the current page's Postings", async () => {
    const visible = "0f1e2d3c4b5a6978"
    const old = "aaaaaaaaaaaaaaaa"
    const result = storeOf({
      [`${USER_ID}/${visible}`]: stored(visible),
      [`${USER_ID}/${old}`]: stored(old),
    })

    const rows = await loadCoverLetterRows(USER_ID, [visible], result.store)

    expect(rows.map((row) => row.postingId)).toEqual([visible])
    expect(result.headed).toEqual([{ userId: USER_ID, postingId: visible }])
  })

  it("omits a Posting with no drafted letter", async () => {
    const postingId = "0f1e2d3c4b5a6978"
    const result = storeOf({
      [`${USER_ID}/${postingId}`]: new ObjectNotFoundError("not-there"),
    })

    await expect(
      loadCoverLetterRows(USER_ID, [postingId], result.store)
    ).resolves.toEqual([])
  })

  it("returns only the metadata the table renders", async () => {
    const postingId = "0f1e2d3c4b5a6978"
    const result = storeOf({
      [`${USER_ID}/${postingId}`]: stored(postingId, {
        provenance: { title: "Backend Engineer", company: "Acme" },
      }),
    })

    const rows = await loadCoverLetterRows(USER_ID, [postingId], result.store)

    expect(rows).toEqual([
      {
        postingId,
        draftedAt: expect.stringContaining("1 Aug 2026"),
        displayName: "Backend Engineer",
        filename: "Cover letter - Backend Engineer - Acme.md",
      },
    ])
  })

  it("reports an unavailable store instead of showing every Posting undrafted", async () => {
    const postingId = "0f1e2d3c4b5a6978"
    const unavailable = new StorageUnavailableError("access denied")
    const result = storeOf({ [`${USER_ID}/${postingId}`]: unavailable })

    await expect(
      loadCoverLetterRows(USER_ID, [postingId], result.store)
    ).rejects.toBe(unavailable)
  })

  it("caps concurrent metadata reads", async () => {
    const postingIds = Array.from({ length: 10 }, (_, index) =>
      String(index).padStart(16, "0")
    )
    let inFlight = 0
    let peak = 0
    const store: CoverLetterStore = {
      put: async () => {
        throw new Error("not used")
      },
      get: async () => {
        throw new Error("not used")
      },
      head: async (ref) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight -= 1
        return stored(ref.postingId)
      },
      delete: async () => {},
    }

    await loadCoverLetterRows(USER_ID, postingIds, store)

    expect(peak).toBe(8)
  })
})
