import type {
  CoverLetterRef,
  CoverLetterStore,
  StoredCoverLetter,
} from "@workspace/user-storage"
import { afterEach, describe, expect, it, vi } from "vitest"

import { listCoverLetters } from "./list-cover-letters"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"

function stored(
  postingId: string,
  draftedAt: string,
  extra: Partial<StoredCoverLetter> = {}
): StoredCoverLetter {
  return {
    key: `prod/${USER_ID}/cover-letters/${postingId}.md`,
    userId: USER_ID,
    postingId,
    size: 2048,
    draftedAt: new Date(draftedAt),
    provenance: {},
    ...extra,
  }
}

/**
 * Mirrors the real store's most surprising behaviour: `list()` carries no user
 * metadata, so provenance and the recorded drafting instant are only available
 * from `head()`. The same shape `list-documents.test.ts` uses, because the trap
 * is the same one.
 *
 * ⚠️ **Keyed by user.** Every fake here is a two-user world, which is what lets
 * the isolation tests below assert on something rather than on a store that
 * only ever held one person's letters.
 */
function storeOf(
  items: Record<string, StoredCoverLetter[]>,
  heads: Record<string, StoredCoverLetter | Error> = {}
): CoverLetterStore & { listedFor: string[]; headedFor: string[] } {
  const listedFor: string[] = []
  const headedFor: string[] = []

  return {
    listedFor,
    headedFor,
    put: async () => {
      throw new Error("not used")
    },
    get: async () => {
      throw new Error("not used")
    },
    head: async (ref: CoverLetterRef) => {
      headedFor.push(ref.userId)

      // The real store addresses `{environment}/{userId}/cover-letters/{id}.md`,
      // so a head for the wrong user is a different object — never the same one
      // with a different label.
      const head = heads[`${ref.userId}/${ref.postingId}`]
      if (head instanceof Error) throw head
      if (!head) throw new Error(`no head for ${ref.userId}/${ref.postingId}`)
      return head
    },
    delete: async () => {},
    list: async (userId: string) => {
      listedFor.push(userId)

      // Stripped exactly as `s3-user-object-store.ts` strips it: ListObjectsV2
      // returns no user metadata, so the store fills in an empty record and the
      // write time stands in for the drafting instant.
      return (items[userId] ?? []).map((item) => ({
        ...item,
        provenance: {},
      }))
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("listCoverLetters", () => {
  it("recovers the provenance that list() cannot return", async () => {
    const store = storeOf(
      { [USER_ID]: [stored("0f1e2d3c4b5a6978", "2026-08-01T00:00:00Z")] },
      {
        [`${USER_ID}/0f1e2d3c4b5a6978`]: stored(
          "0f1e2d3c4b5a6978",
          "2026-08-01T04:15:00Z",
          {
            provenance: {
              title: "Backend Engineer",
              company: "Acme",
              url: "https://www.seek.com.au/job/1",
            },
          }
        ),
      }
    )

    const [letter] = await listCoverLetters(USER_ID, store)

    expect(letter?.title).toBe("Backend Engineer")
    expect(letter?.company).toBe("Acme")
    expect(letter?.url).toBe("https://www.seek.com.au/job/1")
    expect(letter?.displayName).toBe("Backend Engineer")
  })

  it("shows when the letter was drafted, from the recorded instant", async () => {
    const store = storeOf(
      // The listing's date is the object's write time, which the store
      // substitutes when metadata is absent. The head has the real one.
      { [USER_ID]: [stored("0f1e2d3c4b5a6978", "2026-08-02T23:59:00Z")] },
      {
        [`${USER_ID}/0f1e2d3c4b5a6978`]: stored(
          "0f1e2d3c4b5a6978",
          "2026-08-01T04:15:00Z"
        ),
      }
    )

    const [letter] = await listCoverLetters(USER_ID, store)

    expect(letter?.draftedOn.toISOString()).toBe("2026-08-01T04:15:00.000Z")
    // Formatted on the server, UTC, with the zone named — a bare time reads as
    // local and is wrong by hours.
    expect(letter?.draftedAt).toContain("1 Aug 2026")
    expect(letter?.draftedAt).toContain("UTC")
  })

  it("sorts newest first, because key order for digests is arbitrary", async () => {
    const ids = {
      old: "aaaaaaaaaaaaaaaa",
      newest: "bbbbbbbbbbbbbbbb",
      middle: "cccccccccccccccc",
    }

    const store = storeOf(
      {
        [USER_ID]: [
          stored(ids.old, "2026-01-01T00:00:00Z"),
          stored(ids.newest, "2026-08-01T00:00:00Z"),
          stored(ids.middle, "2026-04-01T00:00:00Z"),
        ],
      },
      {
        [`${USER_ID}/${ids.old}`]: stored(ids.old, "2026-01-01T00:00:00Z"),
        [`${USER_ID}/${ids.newest}`]: stored(
          ids.newest,
          "2026-08-01T00:00:00Z"
        ),
        [`${USER_ID}/${ids.middle}`]: stored(
          ids.middle,
          "2026-04-01T00:00:00Z"
        ),
      }
    )

    const letters = await listCoverLetters(USER_ID, store)

    expect(letters.map((letter) => letter.postingId)).toEqual([
      ids.newest,
      ids.middle,
      ids.old,
    ])
  })

  it("degrades one row rather than the page when a head fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const store = storeOf(
      {
        [USER_ID]: [
          stored("aaaaaaaaaaaaaaaa", "2026-08-01T00:00:00Z"),
          stored("bbbbbbbbbbbbbbbb", "2026-07-01T00:00:00Z"),
        ],
      },
      {
        [`${USER_ID}/aaaaaaaaaaaaaaaa`]: stored(
          "aaaaaaaaaaaaaaaa",
          "2026-08-01T00:00:00Z",
          { provenance: { title: "Backend Engineer" } }
        ),
        [`${USER_ID}/bbbbbbbbbbbbbbbb`]: new Error("head failed"),
      }
    )

    const letters = await listCoverLetters(USER_ID, store)

    // Both rows survive, and both still download — the id is what the download
    // route needs, and the listing always has it.
    expect(letters).toHaveLength(2)
    expect(letters[0]?.displayName).toBe("Backend Engineer")
    expect(letters[1]?.displayName).toBe("bbbbbbbbbbbbbbbb")
    expect(letters[1]?.title).toBeUndefined()
  })

  it("logs the key and the reason when a head fails", async () => {
    // The degradation above is silent by design, so this log is the only place
    // the failure exists. Without it an unapplied `prod:cover-letters` grant
    // renders every row as a raw digest and looks like ordinary data.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const reason = new Error("head failed")

    const store = storeOf(
      { [USER_ID]: [stored("aaaaaaaaaaaaaaaa", "2026-08-01T00:00:00Z")] },
      { [`${USER_ID}/aaaaaaaaaaaaaaaa`]: reason }
    )

    await listCoverLetters(USER_ID, store)

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("could not read metadata"),
      `prod/${USER_ID}/cover-letters/aaaaaaaaaaaaaaaa.md`,
      reason
    )
  })

  it("says nothing when every head succeeds", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const store = storeOf(
      { [USER_ID]: [stored("aaaaaaaaaaaaaaaa", "2026-08-01T00:00:00Z")] },
      {
        [`${USER_ID}/aaaaaaaaaaaaaaaa`]: stored(
          "aaaaaaaaaaaaaaaa",
          "2026-08-01T00:00:00Z"
        ),
      }
    )

    await listCoverLetters(USER_ID, store)

    expect(logged).not.toHaveBeenCalled()
  })

  it("names the download after the posting, not after the digest", async () => {
    const store = storeOf(
      { [USER_ID]: [stored("0f1e2d3c4b5a6978", "2026-08-01T00:00:00Z")] },
      {
        [`${USER_ID}/0f1e2d3c4b5a6978`]: stored(
          "0f1e2d3c4b5a6978",
          "2026-08-01T00:00:00Z",
          { provenance: { title: "Backend Engineer", company: "Acme" } }
        ),
      }
    )

    const [letter] = await listCoverLetters(USER_ID, store)

    expect(letter?.filename).toBe("Cover letter - Backend Engineer - Acme.md")
  })

  it("keeps the size from the listing, which always has it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const store = storeOf(
      {
        [USER_ID]: [
          stored("aaaaaaaaaaaaaaaa", "2026-08-01T00:00:00Z", { size: 4096 }),
        ],
      },
      { [`${USER_ID}/aaaaaaaaaaaaaaaa`]: new Error("head failed") }
    )

    const [letter] = await listCoverLetters(USER_ID, store)

    expect(letter?.size).toBe(4096)
  })

  it("returns nothing for a user who has drafted nothing", async () => {
    expect(await listCoverLetters(USER_ID, storeOf({}))).toEqual([])
  })
})

describe("listCoverLetters — a user sees only their own letters", () => {
  /**
   * ⚠️ **The point of this block.** The key is
   * `{environment}/{userId}/cover-letters/{postingId}.md`, and the `userId`
   * segment comes from the session at the call site — never from a form, a query
   * param or a URL. These tests assert the consequence: the id this function is
   * handed is the only prefix it can reach.
   */
  const world = () => ({
    [USER_ID]: [stored("aaaaaaaaaaaaaaaa", "2026-08-01T00:00:00Z")],
    [OTHER_USER_ID]: [
      {
        ...stored("bbbbbbbbbbbbbbbb", "2026-08-02T00:00:00Z"),
        key: `prod/${OTHER_USER_ID}/cover-letters/bbbbbbbbbbbbbbbb.md`,
        userId: OTHER_USER_ID,
      },
    ],
  })

  const heads = () => ({
    [`${USER_ID}/aaaaaaaaaaaaaaaa`]: stored(
      "aaaaaaaaaaaaaaaa",
      "2026-08-01T00:00:00Z",
      { provenance: { title: "Mine" } }
    ),
    [`${OTHER_USER_ID}/bbbbbbbbbbbbbbbb`]: stored(
      "bbbbbbbbbbbbbbbb",
      "2026-08-02T00:00:00Z",
      { provenance: { title: "Not mine" } }
    ),
  })

  it("never returns a letter belonging to someone else", async () => {
    const store = storeOf(world(), heads())

    const letters = await listCoverLetters(USER_ID, store)

    expect(letters.map((letter) => letter.postingId)).toEqual([
      "aaaaaaaaaaaaaaaa",
    ])
    expect(letters.map((letter) => letter.displayName)).toEqual(["Mine"])
  })

  it("addresses only the caller's prefix, on the listing and on every head", async () => {
    const store = storeOf(world(), heads())

    await listCoverLetters(USER_ID, store)

    // Not just "the right rows came back" — the store was never *asked* about
    // another user, which is what makes the ownership assertion inside
    // `@workspace/user-storage` a second line of defence rather than the only
    // one.
    expect(store.listedFor).toEqual([USER_ID])
    expect(store.headedFor).toEqual([USER_ID])
  })

  it("shows the other user their own letter and only that", async () => {
    const store = storeOf(world(), heads())

    const letters = await listCoverLetters(OTHER_USER_ID, store)

    // The mirror image, so a store that ignored `userId` entirely — and
    // therefore passed the first test by returning everything to everyone —
    // fails here.
    expect(letters.map((letter) => letter.displayName)).toEqual(["Not mine"])
    expect(store.headedFor).toEqual([OTHER_USER_ID])
  })
})

describe("listCoverLetters — the head() fan-out", () => {
  /**
   * A store that records how many `head()` calls overlap.
   *
   * Built by swapping one method on {@link storeOf}, for the reason
   * `list-documents.test.ts` gives: a second store written from scratch
   * immediately drifted on the one behaviour these fakes exist to model.
   */
  function countingStore(count: number) {
    const items = Array.from({ length: count }, (_, index) =>
      stored(String(index).padStart(16, "0"), "2026-08-01T00:00:00Z")
    )

    let inFlight = 0
    let peak = 0

    const store: CoverLetterStore = {
      ...storeOf({ [USER_ID]: items }),
      head: async (ref: CoverLetterRef) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)

        // A real timer rather than a microtask, so the measurement is
        // deterministic: every worker the pool starts calls `head()` and
        // increments the counter before any of them suspends.
        await new Promise((resolve) => setTimeout(resolve, 0))

        inFlight -= 1
        return stored(ref.postingId, "2026-08-01T00:00:00Z")
      },
    }

    return { store, peak: () => peak }
  }

  it("caps how many head() calls overlap, without dropping rows", async () => {
    const counting = countingStore(30)

    const letters = await listCoverLetters(USER_ID, counting.store)

    expect(counting.peak()).toBe(8)
    // Bounded, not truncated — a letter that did not render is a letter the
    // user cannot download.
    expect(letters).toHaveLength(30)
  })

  it("does not spawn workers it has no items for", async () => {
    const counting = countingStore(3)

    await listCoverLetters(USER_ID, counting.store)

    expect(counting.peak()).toBe(3)
  })
})
