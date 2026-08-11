import type { StoredTailoredResume } from "@workspace/user-storage"
import { describe, expect, it } from "vitest"

import {
  listTailoredResumes,
  tailoredResumeViewsFor,
} from "./tailored-resume-views"

/**
 * The listing contract — one request per user, missing prefix reads as none,
 * an unreachable store rejects — and the filter-to-page mechanics are
 * `posting-document-views.test.ts`'s. What this suite owns is the resumes'
 * field mapping and the start-early signature the page depends on.
 */

const USER_ID = "11111111-2222-4333-8444-555555555555"

/**
 * A resume as a **listing** returns it: no provenance, and `generatedAt` taken
 * from the object's write time. That is what a `ListObjectsV2` result yields,
 * and building the fixture any richer would let this suite pass over a read
 * path the real store cannot supply.
 */
function listed(postingId: string): StoredTailoredResume {
  return {
    key: `test/${USER_ID}/tailored-resumes/${postingId}.md`,
    userId: USER_ID,
    postingId,
    size: 42,
    generatedAt: new Date("2026-08-06T04:15:00.000Z"),
    provenance: {},
  }
}

describe("listTailoredResumes", () => {
  it("takes no posting ids, so it need not wait for the postings query", () => {
    // Not a style assertion. The page starts this request alongside
    // `listPostings` precisely because it cannot depend on its result, and a
    // second parameter here would be the thing that quietly reintroduced the
    // dependency. `listTailoredResumes.length` counts the declared parameters.
    expect(listTailoredResumes).toHaveLength(2)
  })
})

describe("tailoredResumeViewsFor", () => {
  /**
   * Formatted on the server, like every other date crossing into the table:
   * a `Date` formatted in the browser uses the browser's locale and zone, and
   * React reports the disagreement as a hydration mismatch rather than as the
   * timezone bug it is.
   */
  it("returns only the two fields the panel renders", () => {
    const postingId = "0123456789abcdef"

    const views = tailoredResumeViewsFor([listed(postingId)], [postingId])

    expect(views).toEqual([
      {
        postingId,
        generatedAt: expect.stringContaining("6 Aug 2026"),
      },
    ])
  })
})
