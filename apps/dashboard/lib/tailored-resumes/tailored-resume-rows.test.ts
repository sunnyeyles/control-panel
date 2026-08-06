import { ObjectNotFoundError } from "@workspace/user-storage/errors"
import { StorageUnavailableError } from "@workspace/user-storage/errors"
import type {
  StoredTailoredResume,
  TailoredResumeStore,
} from "@workspace/user-storage/tailored-resume-store"
import { describe, expect, it } from "vitest"

import { loadTailoredResumeRows } from "./tailored-resume-rows"

/**
 * What the postings page reads to know which Postings have a tailored resume.
 *
 * The properties worth pinning are the two that differ from the letters'
 * equivalent — one call rather than one per row, and `null` never standing in
 * for "none" — plus the degradation the page depends on.
 */

const USER_ID = "11111111-2222-4333-8444-555555555555"
const POSTING_ID = "0123456789abcdef"
const SECOND_POSTING_ID = "fedcba9876543210"

function stored(postingId: string, generatedAt: Date): StoredTailoredResume {
  return {
    key: `test/${USER_ID}/tailored-resumes/${postingId}.md`,
    userId: USER_ID,
    postingId,
    size: 42,
    generatedAt,
    // Empty, as a real listing's is: ListObjectsV2 carries no user metadata.
    provenance: {},
  }
}

/** Counts calls, because "one round trip, not twenty-five" is the point. */
class FakeStore {
  calls = 0

  constructor(private readonly answer: () => Promise<StoredTailoredResume[]>) {}

  asStore(): TailoredResumeStore {
    return {
      list: async (userId: string) => {
        this.calls += 1
        expect(userId).toBe(USER_ID)
        return this.answer()
      },
    } as unknown as TailoredResumeStore
  }
}

describe("loadTailoredResumeRows", () => {
  it("asks the store once, however many resumes come back", async () => {
    const store = new FakeStore(async () => [
      stored(POSTING_ID, new Date("2026-08-06T04:15:00.000Z")),
      stored(SECOND_POSTING_ID, new Date("2026-08-05T04:15:00.000Z")),
    ])

    const rows = await loadTailoredResumeRows(USER_ID, store.asStore())

    expect(store.calls).toBe(1)
    expect(rows.map((row) => row.postingId)).toEqual([
      POSTING_ID,
      SECOND_POSTING_ID,
    ])
  })

  /**
   * Formatted on the server, like every other date crossing into the table:
   * a `Date` formatted in the browser uses the browser's locale and zone, and
   * React reports the disagreement as a hydration mismatch rather than as the
   * timezone bug it is.
   */
  it("hands the client a formatted string rather than a Date", async () => {
    const store = new FakeStore(async () => [
      stored(POSTING_ID, new Date("2026-08-06T04:15:00.000Z")),
    ])

    const rows = await loadTailoredResumeRows(USER_ID, store.asStore())

    expect(typeof rows[0]?.generatedAt).toBe("string")
    expect(rows[0]?.generatedAt).not.toHaveLength(0)
  })

  it("is empty for a user who has generated nothing", async () => {
    const store = new FakeStore(async () => [])

    expect(await loadTailoredResumeRows(USER_ID, store.asStore())).toEqual([])
  })

  /**
   * A prefix nobody has written under is "you have generated nothing", not an
   * outage — and telling the page otherwise would put a storage-failure alert
   * above the table of every new user.
   */
  it("reads a missing prefix as none rather than as a failure", async () => {
    const store = new FakeStore(async () => {
      throw new ObjectNotFoundError(`test/${USER_ID}/tailored-resumes/`)
    })

    expect(await loadTailoredResumeRows(USER_ID, store.asStore())).toEqual([])
  })

  /**
   * ⚠️ **The one that must not degrade.** The page turns a rejection into
   * `null` and says the resumes could not be loaded; returning `[]` here would
   * tell someone who has generated one that they have not, and would offer to
   * spend a model call replacing a document nothing could see.
   */
  it("rejects when the store is unreachable, rather than reporting none", async () => {
    const store = new FakeStore(async () => {
      throw new StorageUnavailableError("s3 is having a moment")
    })

    await expect(
      loadTailoredResumeRows(USER_ID, store.asStore())
    ).rejects.toThrow(StorageUnavailableError)
  })
})
