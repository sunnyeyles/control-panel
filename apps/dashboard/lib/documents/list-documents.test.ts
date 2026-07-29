import type {
  ResumeRef,
  ResumeStore,
  StoredResume,
} from "@workspace/user-storage"
import { describe, expect, it, vi } from "vitest"

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
})
