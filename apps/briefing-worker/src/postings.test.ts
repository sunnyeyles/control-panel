import { postingId, type Findings } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import { parsePostedAt, toNewPostings } from "./postings.ts"

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
})

/**
 * The rule for reading a date out of what the scout copied off the page.
 *
 * ⚠️ **The same rule is stated a second time, as a regex**, in
 * `packages/db/prisma/migrations/0006_posting_posted_at/migration.sql`, which
 * backfilled the rows written before the column existed. These cases are what
 * the two have to agree on: a row this rejects and the backfill accepted would
 * sort differently depending only on when it was found.
 */
describe("parsePostedAt", () => {
  it("takes an ISO date, read as UTC", () => {
    expect(parsePostedAt("2026-08-01")).toEqual(
      new Date("2026-08-01T00:00:00.000Z")
    )
  })

  it("takes an ISO datetime", () => {
    expect(parsePostedAt("2026-08-01T09:30:00.000Z")).toEqual(
      new Date("2026-08-01T09:30:00.000Z")
    )
  })

  it("refuses what the page said in words", () => {
    // Every one of these is an ordinary answer from an advertisement, and none
    // of them is a date. `new Date("March 2026")` and Postgres's own reading of
    // `'yesterday'` both succeed, which is why the shape is checked first
    // rather than the parse being trusted.
    for (const value of [
      "3 days ago",
      "Yesterday",
      "yesterday",
      "March 2026",
      "Posted 30 July",
      "",
    ]) {
      expect(parsePostedAt(value)).toBeUndefined()
    }
  })

  /**
   * ⚠️ `new Date("2026-02-30")` answers 2 March rather than failing, so this is
   * the case a `Number.isNaN` check alone silently passes — and passing it
   * means storing a day the advertisement never named.
   */
  it("refuses a date-shaped string that is not a day", () => {
    expect(parsePostedAt("2026-02-30")).toBeUndefined()
    expect(parsePostedAt("2026-13-01")).toBeUndefined()
    expect(parsePostedAt("2026-02-30T09:00:00.000Z")).toBeUndefined()
  })

  /**
   * The one shape the two sides could not agree on: `new Date` reads it in the
   * machine's zone and Postgres in the database's, so both refuse it rather
   * than storing a day that depends on where the code ran.
   */
  it("refuses a datetime separated by a space rather than a T", () => {
    expect(parsePostedAt("2026-08-01 09:30")).toBeUndefined()
  })

  it("refuses an absent value", () => {
    expect(parsePostedAt(undefined)).toBeUndefined()
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
