import { postingId, type Findings } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import { toNewPostings } from "./postings.ts"

/**
 * The seam between the two packages, tested for the properties that make the
 * cumulative record cumulative: the id is the agents package's own, the payload
 * is the Posting rather than a summary of it, and the one field that becomes a
 * column by being *interpreted* rather than copied is interpreted narrowly.
 */

const CANONICAL = "https://www.seek.com.au/job/93431609"

function posting(overrides: Partial<Findings["postings"][number]> = {}) {
  return {
    title: "Senior Backend Engineer",
    company: "Acme",
    location: "Sydney NSW (Hybrid)",
    url: CANONICAL,
    highlights: ["Own async pipelines & AWS infra"],
    summary: "A backend role on a real-time data product.",
    matchReason: "Backend, Sydney, Python and AWS.",
    ...overrides,
  }
}

describe("toNewPostings", () => {
  it("derives the id with the agents package's own function", () => {
    const [row] = toNewPostings({ postings: [posting()] })

    // Equality with `postingId()` rather than a hard-coded digest: what must
    // never drift is the *rule*, and a literal here would keep passing after a
    // reimplementation started disagreeing with it.
    expect(row?.postingId).toBe(postingId({ url: CANONICAL }))
    expect(row?.postingId).toMatch(/^[0-9a-f]{16}$/)
  })

  it("gives two sightings of one advertisement the same id", () => {
    // SEEK stamps `ref=` with the search that surfaced a listing, so the same
    // posting reached two ways is the ordinary case rather than an edge one.
    // Matching ids are what let `recordPostings` merge them — into one row
    // across runs, and within a single batch, where two rows sharing a conflict
    // target would otherwise raise Postgres `21000`.
    const rows = toNewPostings({
      postings: [
        posting(),
        posting({ url: `${CANONICAL}?ref=search-standalone` }),
      ],
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]?.postingId).toBe(rows[1]?.postingId)
  })

  it("distinguishes two different advertisements", () => {
    const rows = toNewPostings({
      postings: [posting(), posting({ url: "https://example.com/jobs/2" })],
    })

    expect(rows[0]?.postingId).not.toBe(rows[1]?.postingId)
  })

  it("keeps the whole posting as the payload, beside the sorted columns", () => {
    const found = posting({ postedAt: "2026-08-01" })
    const [row] = toNewPostings({ postings: [found], notes: "One source." })

    // The columns are the projection the table sorts and displays on; the
    // payload is what a reader and the cover-letter writer are given, so the
    // fields those columns leave out have to survive.
    expect(row).toMatchObject({
      title: found.title,
      company: found.company,
      location: found.location,
      url: found.url,
    })
    expect(row?.payload).toEqual(found)
  })

  it("projects the posting date onto a column and leaves the payload alone", () => {
    const found = posting({ postedAt: "2026-08-01" })
    const [row] = toNewPostings({ postings: [found] })

    expect(row?.postedAt).toEqual(new Date("2026-08-01T00:00:00.000Z"))
    // Not the parsed form: the payload is what the advertisement said.
    expect(row?.payload.postedAt).toBe("2026-08-01")
  })

  it("records no posting date when the advertisement stated one in prose", () => {
    const found = posting({ postedAt: "3 days ago" })
    const [row] = toNewPostings({ postings: [found] })

    // Absent rather than a guess, and the words survive in the payload — the
    // table falls back to rendering them.
    expect(row?.postedAt).toBeUndefined()
    expect(row?.payload.postedAt).toBe("3 days ago")
  })

  it("records no posting date when the advertisement stated none", () => {
    const [row] = toNewPostings({ postings: [posting()] })

    expect(row?.postedAt).toBeUndefined()
  })

  it("has nothing to record when the search found nothing", () => {
    expect(toNewPostings({ postings: [], notes: "Nothing open." })).toEqual([])
  })

  it("keeps the scout's order, which is best match first", () => {
    const rows = toNewPostings({
      postings: [
        posting({ url: "https://example.com/jobs/1" }),
        posting({ url: "https://example.com/jobs/2" }),
        posting({ url: "https://example.com/jobs/3" }),
      ],
    })

    expect(rows.map((row) => row.url)).toEqual([
      "https://example.com/jobs/1",
      "https://example.com/jobs/2",
      "https://example.com/jobs/3",
    ])
  })
})
