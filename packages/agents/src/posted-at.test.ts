import { describe, expect, it } from "vitest"

import { parsePostedAt } from "./posted-at.ts"

/**
 * The rule for reading a date out of what a producer copied off the page.
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

  it("takes a datetime at an offset other than UTC", () => {
    expect(parsePostedAt("2026-08-01T09:30:00+10:00")).toEqual(
      new Date("2026-07-31T23:30:00.000Z")
    )
    expect(parsePostedAt("2026-08-01T09:30Z")).toEqual(
      new Date("2026-08-01T09:30:00.000Z")
    )
  })

  /**
   * ⚠️ Neither shape names an offset, so `new Date` reads it in the machine's
   * zone and Postgres in the database's — the same hazard twice, and the reason
   * both are refused rather than stored as a day that depends on where the code
   * ran. The `T` form is the one that looks acceptable and is not: it is
   * ISO-shaped, it parses, and on a laptop in `Australia/Sydney` it would put
   * an advertisement that said 1 August onto 31 July.
   */
  it("refuses a datetime that names no offset", () => {
    expect(parsePostedAt("2026-08-01 09:30")).toBeUndefined()
    expect(parsePostedAt("2026-08-01T09:30")).toBeUndefined()
    expect(parsePostedAt("2026-08-01T09:30:00")).toBeUndefined()
    expect(parsePostedAt("2026-08-01T09:30:00.000")).toBeUndefined()
  })

  it("refuses an absent value", () => {
    expect(parsePostedAt(undefined)).toBeUndefined()
  })
})
