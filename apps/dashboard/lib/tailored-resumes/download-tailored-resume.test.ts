import {
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
} from "@workspace/user-storage/errors"
import type {
  StoredTailoredResume,
  TailoredResumeRef,
  TailoredResumeStore,
} from "@workspace/user-storage/tailored-resume-store"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { downloadTailoredResume } from "./download-tailored-resume"

/**
 * Fetching one tailored resume, and the ownership rule that makes the route
 * safe.
 *
 * The property under test is that the object addressed is the *caller's* and
 * can be nothing else — the `userId` comes from the session and the `postingId`
 * from the URL, never the other way round. A session is exactly what a test
 * cannot produce, which is why this function takes both as arguments and the
 * route is the only part left untested.
 */

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const POSTING_ID = "0123456789abcdef"
const RESUME = "# Alice Example\n\n## Experience\n\n- Payment services."

class FakeStore {
  readonly asked: TailoredResumeRef[] = []

  constructor(
    private readonly answer: (
      ref: TailoredResumeRef
    ) => Promise<StoredTailoredResume>
  ) {}

  asStore(): TailoredResumeStore {
    return {
      get: async (ref: TailoredResumeRef) => {
        this.asked.push(ref)
        return this.answer(ref)
      },
    } as unknown as TailoredResumeStore
  }
}

function found(
  overrides: Partial<StoredTailoredResume> = {}
): StoredTailoredResume {
  return {
    key: `test/${USER_ID}/tailored-resumes/${POSTING_ID}.md`,
    userId: USER_ID,
    postingId: POSTING_ID,
    size: RESUME.length,
    generatedAt: new Date("2026-08-06T04:15:00.000Z"),
    provenance: { title: "Backend Engineer", company: "Acme" },
    markdown: RESUME,
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("downloadTailoredResume", () => {
  it("returns the markdown and a filename naming the posting", async () => {
    const store = new FakeStore(async () => found())

    const result = await downloadTailoredResume(
      USER_ID,
      POSTING_ID,
      store.asStore()
    )

    expect(result).toEqual({
      status: "ok",
      markdown: RESUME,
      filename: "Tailored resume - Backend Engineer - Acme.md",
    })
  })

  /**
   * "Tailored resume", not "Resume": the Documents shelf is full of files the
   * user would call a resume, and a download landing beside them under that
   * name is one the app generated pretending to be one they wrote.
   */
  it("falls back to the Posting id when there is no provenance to name it by", async () => {
    const store = new FakeStore(async () => found({ provenance: {} }))

    const result = await downloadTailoredResume(
      USER_ID,
      POSTING_ID,
      store.asStore()
    )

    expect(result).toMatchObject({
      filename: `Tailored resume - ${POSTING_ID}.md`,
    })
  })

  /**
   * ⚠️ The whole point of the argument order. There is no way to spell a
   * request that names another user's object, because the only thing a caller
   * supplies is the last segment of the key.
   */
  it("addresses the object with the caller's id, never one from the path", async () => {
    const store = new FakeStore(async () => found())

    await downloadTailoredResume(USER_ID, POSTING_ID, store.asStore())

    expect(store.asked).toEqual([{ userId: USER_ID, postingId: POSTING_ID }])
    expect(store.asked[0]?.userId).not.toBe(OTHER_USER_ID)
  })

  /**
   * Before the store is touched at all. A value the store would refuse cannot
   * name an object, and answering "failed" would report a hand-edited URL as a
   * server fault and fill the log with alarms anyone can trigger.
   */
  it("refuses a malformed id without asking the store", async () => {
    const store = new FakeStore(async () => found())

    const result = await downloadTailoredResume(
      USER_ID,
      "../../someone-else",
      store.asStore()
    )

    expect(result).toEqual({ status: "not-found" })
    expect(store.asked).toHaveLength(0)
  })

  /**
   * Three different refusals, one answer — deliberately. Splitting them would
   * turn the route into an oracle for whether another user's Posting id exists.
   */
  it.each([
    ["missing", new ObjectNotFoundError("k")],
    ["someone else's", new ObjectOwnershipError("k", USER_ID, OTHER_USER_ID)],
  ])("reports a %s object as not-found", async (_label, error) => {
    const store = new FakeStore(async () => {
      throw error
    })

    expect(
      await downloadTailoredResume(USER_ID, POSTING_ID, store.asStore())
    ).toEqual({ status: "not-found" })
  })

  /**
   * And the one that must *not* be conflated: an outage reported as "not found"
   * would tell someone their document is gone.
   */
  it("reports an unreachable bucket as a failure, not as not-found", async () => {
    const store = new FakeStore(async () => {
      throw new StorageUnavailableError("s3 is having a moment")
    })

    expect(
      await downloadTailoredResume(USER_ID, POSTING_ID, store.asStore())
    ).toEqual({ status: "failed" })
  })

  /** Handing back an empty file would look like a successful download. */
  it("fails rather than serving an object with no body", async () => {
    const store = new FakeStore(async () => found({ markdown: undefined }))

    expect(
      await downloadTailoredResume(USER_ID, POSTING_ID, store.asStore())
    ).toEqual({ status: "failed" })
  })
})
