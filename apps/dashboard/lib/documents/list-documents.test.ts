import type {
  ResumeRef,
  ResumeStore,
  StoredResume,
} from "@workspace/user-storage"
import { afterEach, describe, expect, it, vi } from "vitest"

import { listDocuments } from "./list-documents"

const USER_ID = "11111111-2222-4333-8444-555555555555"

function stored(
  resumeId: string,
  uploadedAt: string,
  extra: Partial<StoredResume> = {}
): StoredResume {
  return {
    key: `prod/${USER_ID}/resumes/${resumeId}.pdf`,
    userId: USER_ID,
    resumeId,
    extension: ".pdf",
    contentType: "application/pdf",
    size: 1024,
    uploadedAt: new Date(uploadedAt),
    ...extra,
  }
}

/**
 * Mirrors the real store's most surprising behaviour: `list()` carries no user
 * metadata, so a filename or type is only available from `head()`.
 */
function storeOf(
  items: StoredResume[],
  heads: Record<string, StoredResume | Error> = {}
): ResumeStore {
  return {
    put: async () => {
      throw new Error("not used")
    },
    get: async () => {
      throw new Error("not used")
    },
    head: async (ref: ResumeRef) => {
      const head = heads[ref.resumeId]
      if (head instanceof Error) throw head
      if (!head) throw new Error(`no head for ${ref.resumeId}`)
      return head
    },
    delete: async () => {},
    list: async () =>
      // Stripped exactly as `s3-user-object-store.ts` strips it.
      items.map((item) => ({
        ...item,
        originalFilename: undefined,
        documentType: undefined,
      })),
  }
}

// Several tests below silence `console.error`, and `vi.spyOn` on an already
// spied method hands back the *same* mock with its call list intact. Without
// this, "was nothing logged?" reads calls another test made.
afterEach(() => {
  vi.restoreAllMocks()
})

describe("listDocuments", () => {
  it("recovers the display name and type that list() cannot return", async () => {
    const items = [stored("a", "2026-07-01T00:00:00Z")]
    const store = storeOf(items, {
      a: stored("a", "2026-07-01T00:00:00Z", {
        originalFilename: "My CV.pdf",
        documentType: "resume",
      }),
    })

    const [document] = await listDocuments(USER_ID, store)

    expect(document?.displayName).toBe("My CV.pdf")
    expect(document?.documentType).toBe("resume")
  })

  it("sorts newest first, because key order for uuids is arbitrary", async () => {
    const items = [
      stored("older", "2026-01-01T00:00:00Z"),
      stored("newest", "2026-07-01T00:00:00Z"),
      stored("middle", "2026-04-01T00:00:00Z"),
    ]

    const store = storeOf(items, {
      older: stored("older", "2026-01-01T00:00:00Z", {
        originalFilename: "old.pdf",
      }),
      newest: stored("newest", "2026-07-01T00:00:00Z", {
        originalFilename: "new.pdf",
      }),
      middle: stored("middle", "2026-04-01T00:00:00Z", {
        originalFilename: "mid.pdf",
      }),
    })

    const documents = await listDocuments(USER_ID, store)

    expect(documents.map((d) => d.resumeId)).toEqual([
      "newest",
      "middle",
      "older",
    ])
  })

  it("degrades one row rather than the page when a head fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const items = [
      stored("good", "2026-07-01T00:00:00Z"),
      stored("broken", "2026-06-01T00:00:00Z"),
    ]

    const store = storeOf(items, {
      good: stored("good", "2026-07-01T00:00:00Z", {
        originalFilename: "good.pdf",
      }),
      broken: new Error("head failed"),
    })

    const documents = await listDocuments(USER_ID, store)

    // Both rows survive. Without this, one unreadable object makes the page
    // throw and the user cannot even delete the thing causing it.
    expect(documents).toHaveLength(2)
    expect(documents[0]?.displayName).toBe("good.pdf")
    expect(documents[1]?.displayName).toBe("broken.pdf")
    expect(documents[1]?.documentType).toBeUndefined()
  })

  it("falls back to the id when there is no stored filename", async () => {
    const items = [stored("abc", "2026-07-01T00:00:00Z")]
    const store = storeOf(items, { abc: stored("abc", "2026-07-01T00:00:00Z") })

    const [document] = await listDocuments(USER_ID, store)

    expect(document?.displayName).toBe("abc.pdf")
  })

  it("builds the download segment from the id and extension", async () => {
    const items = [stored("abc", "2026-07-01T00:00:00Z")]
    const store = storeOf(items, {
      abc: stored("abc", "2026-07-01T00:00:00Z", {
        originalFilename: "anything at all.pdf",
      }),
    })

    const [document] = await listDocuments(USER_ID, store)

    // Never the filename: it is attacker-controlled text and this ends up in a
    // URL path.
    expect(document?.file).toBe("abc.pdf")
  })

  it("returns nothing for a user with no documents", async () => {
    expect(await listDocuments(USER_ID, storeOf([]))).toEqual([])
  })

  it("keeps size and uploadedAt from the listing, which always has them", async () => {
    const items = [stored("a", "2026-07-01T00:00:00Z", { size: 4096 })]
    const store = storeOf(items, { a: new Error("head failed") })

    vi.spyOn(console, "error").mockImplementation(() => {})

    const [document] = await listDocuments(USER_ID, store)

    expect(document?.size).toBe(4096)
    expect(document?.uploadedAt).toEqual(new Date("2026-07-01T00:00:00Z"))
  })

  it("logs the key and the reason when a head fails", async () => {
    // The degradation above is silent by design, so this log is the only place
    // the failure exists. Without it a broken IAM attachment renders every row
    // as a raw uuid and looks exactly like a user who never named their files.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const reason = new Error("head failed")
    const items = [stored("broken", "2026-07-01T00:00:00Z")]

    await listDocuments(USER_ID, storeOf(items, { broken: reason }))

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("could not read metadata"),
      `prod/${USER_ID}/resumes/broken.pdf`,
      reason
    )
  })

  it("says nothing when every head succeeds", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const items = [stored("a", "2026-07-01T00:00:00Z")]
    const store = storeOf(items, {
      a: stored("a", "2026-07-01T00:00:00Z", { originalFilename: "cv.pdf" }),
    })

    await listDocuments(USER_ID, store)

    expect(logged).not.toHaveBeenCalled()
  })
})

describe("listDocuments — the head() fan-out", () => {
  /**
   * A store that records how many `head()` calls overlap.
   *
   * The yield is a real timer rather than a microtask so the measurement is
   * deterministic: every worker the pool starts calls `head()` and increments
   * the counter before any of them suspends, so `peak` is exactly the pool
   * size rather than whatever the scheduler happened to interleave.
   */
  function countingStore(count: number) {
    const items = Array.from({ length: count }, (_, index) =>
      stored(`doc-${index}`, "2026-07-01T00:00:00Z")
    )

    let inFlight = 0
    let peak = 0

    const store: ResumeStore = {
      put: async () => {
        throw new Error("not used")
      },
      get: async () => {
        throw new Error("not used")
      },
      head: async (ref: ResumeRef) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)

        await new Promise((resolve) => setTimeout(resolve, 0))

        inFlight -= 1
        return stored(ref.resumeId, "2026-07-01T00:00:00Z", {
          originalFilename: `${ref.resumeId}.pdf`,
        })
      },
      delete: async () => {},
      list: async () => items,
    }

    return { store, peak: () => peak }
  }

  it("caps how many head() calls overlap, without dropping rows", async () => {
    // 30 documents is not a realistic number for one person. That is the
    // point: the burst is bounded by this code rather than by how few files
    // the user happens to have.
    const counting = countingStore(30)

    const documents = await listDocuments(USER_ID, counting.store)

    expect(counting.peak()).toBe(8)
    // Bounded, not truncated — every row still comes back, only slower.
    expect(documents).toHaveLength(30)
  })

  it("does not spawn workers it has no items for", async () => {
    const counting = countingStore(3)

    await listDocuments(USER_ID, counting.store)

    expect(counting.peak()).toBe(3)
  })
})
