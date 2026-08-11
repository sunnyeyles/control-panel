import type { StoredCoverLetter } from "@workspace/user-storage"
import { describe, expect, it } from "vitest"

import { coverLetterViewsFor, listCoverLetters } from "./cover-letter-views"

/**
 * The listing contract — one request per user, missing prefix reads as none,
 * an unreachable store rejects — and the filter-to-page mechanics are
 * `posting-document-views.test.ts`'s. What this suite owns is the letters'
 * field mapping and the start-early signature the page depends on.
 */

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

describe("listCoverLetters", () => {
  it("takes no posting ids, so it need not wait for the postings query", () => {
    // Not a style assertion. The page starts this request alongside
    // `listPostings` precisely because it cannot depend on its result, and a
    // second parameter here would be the thing that quietly reintroduced the
    // dependency. `listCoverLetters.length` counts the declared parameters.
    expect(listCoverLetters).toHaveLength(2)
  })
})

describe("coverLetterViewsFor", () => {
  it("returns only the two fields the table renders", () => {
    const postingId = "0f1e2d3c4b5a6978"

    const views = coverLetterViewsFor([listed(postingId)], [postingId])

    // Not `displayName` and not `filename`: a listing carries no object
    // metadata, so both are derived from the Posting in `posting-detail.tsx`.
    expect(views).toEqual([
      { postingId, draftedAt: expect.stringContaining("1 Aug 2026") },
    ])
  })
})
