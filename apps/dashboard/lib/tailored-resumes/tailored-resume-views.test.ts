import type {
  StoredTailoredResume,
  TailoredResumeStore,
} from "@workspace/user-storage/tailored-resume-store"
import { describe, expect, it } from "vitest"

import { loadTailoredResumeViews } from "./tailored-resume-views"

/**
 * The listing contract — one request per user, missing prefix reads as none,
 * an unreachable store rejects — is `posting-document-views.test.ts`'s. What
 * this suite owns is the resumes' field mapping.
 */

const USER_ID = "11111111-2222-4333-8444-555555555555"
const POSTING_ID = "0123456789abcdef"

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

function storeOf(resumes: StoredTailoredResume[]): TailoredResumeStore {
  return {
    list: async () => resumes,
  } as unknown as TailoredResumeStore
}

describe("loadTailoredResumeViews", () => {
  /**
   * Formatted on the server, like every other date crossing into the table:
   * a `Date` formatted in the browser uses the browser's locale and zone, and
   * React reports the disagreement as a hydration mismatch rather than as the
   * timezone bug it is.
   */
  it("maps each resume to its Posting id and a formatted instant", async () => {
    const views = await loadTailoredResumeViews(
      USER_ID,
      storeOf([stored(POSTING_ID, new Date("2026-08-06T04:15:00.000Z"))])
    )

    expect(views).toEqual([
      {
        postingId: POSTING_ID,
        generatedAt: expect.stringContaining("6 Aug 2026"),
      },
    ])
  })
})
