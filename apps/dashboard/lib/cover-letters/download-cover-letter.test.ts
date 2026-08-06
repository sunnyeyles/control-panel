import {
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
  type CoverLetterRef,
  type CoverLetterStore,
  type StoredCoverLetter,
} from "@workspace/user-storage"
import { afterEach, describe, expect, it, vi } from "vitest"

import { downloadCoverLetter } from "./download-cover-letter"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const POSTING_ID = "0f1e2d3c4b5a6978"

function letter(
  userId: string,
  postingId: string,
  markdown: string,
  provenance: StoredCoverLetter["provenance"] = {}
): StoredCoverLetter {
  return {
    key: `prod/${userId}/cover-letters/${postingId}.md`,
    userId,
    postingId,
    size: markdown.length,
    draftedAt: new Date("2026-08-01T04:15:00Z"),
    provenance,
    markdown,
  }
}

/**
 * A store holding two users' letters, addressed the way the real one is:
 * `userId` is part of the key, so a `get()` for the wrong user is a different
 * object and not the same one relabelled.
 */
function storeOf(objects: StoredCoverLetter[]): CoverLetterStore & {
  askedFor: CoverLetterRef[]
} {
  const askedFor: CoverLetterRef[] = []

  return {
    askedFor,
    put: async () => {
      throw new Error("not used")
    },
    head: async () => {
      throw new Error("not used")
    },
    list: async () => {
      throw new Error("not used")
    },
    delete: async () => {},
    get: async (ref: CoverLetterRef) => {
      askedFor.push(ref)

      const found = objects.find(
        (object) =>
          object.userId === ref.userId && object.postingId === ref.postingId
      )

      if (!found) {
        throw new ObjectNotFoundError(
          `prod/${ref.userId}/cover-letters/${ref.postingId}.md`
        )
      }

      return found
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("downloadCoverLetter", () => {
  it("returns the markdown of the caller's letter", async () => {
    const store = storeOf([letter(USER_ID, POSTING_ID, "Dear Hiring Team")])

    const result = await downloadCoverLetter(USER_ID, POSTING_ID, store)

    expect(result).toMatchObject({
      status: "ok",
      markdown: "Dear Hiring Team",
    })
  })

  it("names the file after the posting rather than the digest", async () => {
    const store = storeOf([
      letter(USER_ID, POSTING_ID, "Dear Hiring Team", {
        title: "Backend Engineer",
        company: "Acme",
      }),
    ])

    const result = await downloadCoverLetter(USER_ID, POSTING_ID, store)

    expect(result).toMatchObject({
      filename: "Cover letter - Backend Engineer - Acme.md",
    })
  })

  it("falls back to the digest when provenance recorded nothing", async () => {
    const store = storeOf([letter(USER_ID, POSTING_ID, "x")])

    const result = await downloadCoverLetter(USER_ID, POSTING_ID, store)

    expect(result).toMatchObject({
      filename: `Cover letter - ${POSTING_ID}.md`,
    })
  })

  it("is not found when the letter does not exist", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = await downloadCoverLetter(USER_ID, POSTING_ID, storeOf([]))

    expect(result).toEqual({ status: "not-found" })
  })

  it("answers not-found rather than failed for a malformed id, without touching the store", async () => {
    const store = storeOf([letter(USER_ID, POSTING_ID, "x")])

    // A path traversal, an uppercase digest, a uuid, an empty segment. None can
    // name an object, and a 500 for any of them would report a malformed URL as
    // a server fault and fill the log with alarms anyone can trigger from the
    // address bar.
    for (const bad of [
      "../../etc/passwd",
      "0F1E2D3C4B5A6978",
      "0f1e2d3c4b5a697",
      "11111111-2222-4333-8444-555555555555",
      "",
    ]) {
      expect(await downloadCoverLetter(USER_ID, bad, store)).toEqual({
        status: "not-found",
      })
    }

    expect(store.askedFor).toEqual([])
  })

  it("conflates a storage ownership failure with not-found", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const store: CoverLetterStore = {
      ...storeOf([]),
      get: async () => {
        throw new ObjectOwnershipError(
          `prod/${OTHER_USER_ID}/cover-letters/${POSTING_ID}.md`,
          USER_ID,
          OTHER_USER_ID
        )
      },
    }

    // Deliberate: distinguishing them would say whether another user's letter
    // exists to someone who may not read it.
    expect(await downloadCoverLetter(USER_ID, POSTING_ID, store)).toEqual({
      status: "not-found",
    })
  })

  it("reports a storage outage as a failure rather than as a missing letter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const store: CoverLetterStore = {
      ...storeOf([]),
      get: async () => {
        // Where an unapplied `prod:cover-letters` grant lands: AccessDenied.
        throw new StorageUnavailableError("AccessDenied")
      },
    }

    expect(await downloadCoverLetter(USER_ID, POSTING_ID, store)).toEqual({
      status: "failed",
    })
  })

  it("refuses to hand back an empty file as a successful download", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const store = storeOf([letter(USER_ID, POSTING_ID, "")])

    expect(await downloadCoverLetter(USER_ID, POSTING_ID, store)).toEqual({
      status: "failed",
    })
    expect(logged).toHaveBeenCalled()
  })
})

describe("downloadCoverLetter — a user downloads only their own letters", () => {
  /**
   * ⚠️ **The property this block exists for.** The caller supplies the Posting
   * id and nothing else; the `userId` segment of the key comes from the session
   * at the call site (`app/api/cover-letters/[postingId]/route.ts`). Ownership
   * is therefore structural — a request naming another user's letter cannot be
   * spelled — and these tests are what stop that from being quietly undone by a
   * future `userId` parameter arriving from the URL.
   */
  const world = () => [
    letter(USER_ID, POSTING_ID, "Mine", { title: "Mine" }),
    letter(OTHER_USER_ID, POSTING_ID, "Not mine", { title: "Not mine" }),
  ]

  it("does not return another user's letter at the same posting id", async () => {
    const store = storeOf(world())

    // The same id, drafted by both users. The only thing separating the two
    // objects is the key segment this function is handed.
    const mine = await downloadCoverLetter(USER_ID, POSTING_ID, store)
    const theirs = await downloadCoverLetter(OTHER_USER_ID, POSTING_ID, store)

    expect(mine).toMatchObject({ markdown: "Mine" })
    expect(theirs).toMatchObject({ markdown: "Not mine" })
  })

  it("asks the store only for the caller's own key", async () => {
    const store = storeOf(world())

    await downloadCoverLetter(USER_ID, POSTING_ID, store)

    expect(store.askedFor).toEqual([{ userId: USER_ID, postingId: POSTING_ID }])
  })

  it("is not found when the caller has no letter for a posting someone else drafted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const store = storeOf([
      letter(OTHER_USER_ID, POSTING_ID, "Not mine", { title: "Not mine" }),
    ])

    // Not "forbidden", and not the other user's bytes: the caller's prefix
    // simply holds nothing at that address.
    expect(await downloadCoverLetter(USER_ID, POSTING_ID, store)).toEqual({
      status: "not-found",
    })
  })
})
