import { MAX_POSTINGS_PER_BRIEF } from "@workspace/job-search"
import { describe, expect, it } from "vitest"

import { MAX_ROLE_TITLES } from "./criteria-text"
import { MAX_CRITERIA_ITEMS, searchCriteriaSchema } from "./search-criteria"

/**
 * What this schema is for is the reason to test it at all: it stands in for the
 * worker's `JobSearchConfigSchema`, which the dashboard cannot import. Nothing
 * checks that the two still agree, so the properties asserted here — one title
 * and one location minimum, arrays of trimmed non-empty strings, an optional
 * keywords list — are the copy of that contract this app is holding.
 */

/** The valid required half, so a case can vary one thing at a time. */
const REQUIRED = {
  titles: "senior backend engineer, staff engineer",
  locations: "Sydney, Remote (Australia)",
}

/** `n` distinct entries as one comma-separated field. */
const list = (n: number) =>
  Array.from({ length: n }, (_, index) => `entry ${index}`).join(", ")

/**
 * The parsed value, or a failure that names itself.
 *
 * Narrowing here rather than at every call site keeps the assertions about the
 * criteria instead of about `safeParse`'s result union.
 */
function parse(input: unknown) {
  const result = searchCriteriaSchema.safeParse(input)

  if (!result.success) {
    throw new Error(`expected a successful parse: ${result.error.message}`)
  }

  return result.data
}

/** Whether the schema turns this input away. */
const rejects = (input: unknown) =>
  !searchCriteriaSchema.safeParse(input).success

describe("titles and locations", () => {
  it("splits on commas and trims each entry", () => {
    expect(
      parse({
        titles: "  senior backend engineer ,staff engineer  ",
        locations: "Sydney,   Remote (Australia)",
      })
    ).toMatchObject({
      titles: ["senior backend engineer", "staff engineer"],
      locations: ["Sydney", "Remote (Australia)"],
    })
  })

  it("keeps a single entry with no comma in it", () => {
    expect(
      parse({ titles: "backend engineer", locations: "Sydney" })
    ).toMatchObject({
      titles: ["backend engineer"],
      locations: ["Sydney"],
    })
  })

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["commas only", " , , "],
  ])("rejects titles that are %s", (_label, titles) => {
    // The failure that matters. A job created with no titles claims its first
    // slot and then dies on a config the worker cannot read, so "no titles" has
    // to be a rejection here rather than an empty array in the row.
    expect(rejects({ ...REQUIRED, titles })).toBe(true)
  })

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["commas only", " , , "],
  ])("rejects locations that are %s", (_label, locations) => {
    expect(rejects({ ...REQUIRED, locations })).toBe(true)
  })

  it("rejects a missing field rather than treating it as empty", () => {
    // `formData.get()` answers `null` for a field that was never posted, which
    // is what a hand-made POST looks like. Required means required.
    expect(rejects({ locations: "Sydney" })).toBe(true)
    expect(rejects({ ...REQUIRED, locations: null })).toBe(true)
  })

  it("accepts exactly the locations cap and rejects one more", () => {
    expect(
      parse({ ...REQUIRED, locations: list(MAX_CRITERIA_ITEMS) }).locations
    ).toHaveLength(MAX_CRITERIA_ITEMS)

    // Not validation for its own sake: the cap is what stops one paste from
    // writing an unbounded row.
    expect(
      rejects({ ...REQUIRED, locations: list(MAX_CRITERIA_ITEMS + 1) })
    ).toBe(true)
  })

  /**
   * ⚠️ **Titles is capped far lower than everything else, and not for paste
   * safety.** A run fans out to `titles × locations × boards` searches against
   * a hard model budget; past it the scout is cut off mid-sweep and still
   * answers with a well-formed brief covering less than it was asked to. See
   * `MAX_ROLE_TITLES`.
   *
   * The form disables its own submit before this is reached. This is the half
   * that a direct POST still has to get past.
   */
  it("accepts exactly the title cap and rejects one more", () => {
    expect(
      parse({ ...REQUIRED, titles: list(MAX_ROLE_TITLES) }).titles
    ).toHaveLength(MAX_ROLE_TITLES)

    expect(rejects({ ...REQUIRED, titles: list(MAX_ROLE_TITLES + 1) })).toBe(
      true
    )
  })

  it("caps titles well below the paste bound the other fields carry", () => {
    expect(MAX_ROLE_TITLES).toBeLessThan(MAX_CRITERIA_ITEMS)
  })
})

describe("keywords", () => {
  it("splits and trims like the required fields", () => {
    expect(
      parse({ ...REQUIRED, keywords: " TypeScript ,Postgres,  AWS " }).keywords
    ).toEqual(["TypeScript", "Postgres", "AWS"])
  })

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["commas only", " , , "],
    ["a field that was never posted", null],
  ])("parses %s as no keywords rather than failing", (_label, keywords) => {
    // The whole point of the optional list. Every one of these is a user who
    // left the box alone, and none of them may block a create — contrast the
    // titles cases above, which must fail.
    expect(parse({ ...REQUIRED, keywords }).keywords).toEqual([])
  })

  it("does not require the key to be present at all", () => {
    // `createJobAction` always passes it — `formData.get("keywords")`, which is
    // `null` when absent and covered above — so this is about the schema being
    // usable by a caller that has no keywords to offer, not about the form.
    expect(rejects(REQUIRED)).toBe(false)
  })

  it("still enforces the cap", () => {
    expect(
      parse({ ...REQUIRED, keywords: list(MAX_CRITERIA_ITEMS) }).keywords
    ).toHaveLength(MAX_CRITERIA_ITEMS)

    // Optional means "may be empty", not "may be unbounded" — an extracted
    // technology list is exactly the input likely to arrive long.
    expect(
      rejects({ ...REQUIRED, keywords: list(MAX_CRITERIA_ITEMS + 1) })
    ).toBe(true)
  })

  it("does not interfere with the required fields", () => {
    expect(parse({ ...REQUIRED, keywords: "TypeScript" })).toMatchObject({
      titles: ["senior backend engineer", "staff engineer"],
      locations: ["Sydney", "Remote (Australia)"],
      keywords: ["TypeScript"],
    })
  })
})

describe("maxPostings", () => {
  it("reads the number out of the string a form posts", () => {
    expect(parse({ ...REQUIRED, maxPostings: " 12 " }).maxPostings).toBe(12)
  })

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a field that was never posted", null],
    ["a key that is absent entirely", undefined],
  ])("parses %s as no answer rather than as zero", (_label, maxPostings) => {
    // `Number("")` is `0`, which the worker's minimum would reject — so a user
    // who left the box alone must not be told their number is too small. Absent
    // also has to stay absent all the way through: it is what makes a briefing
    // follow the default when the default changes.
    expect(parse({ ...REQUIRED, maxPostings }).maxPostings).toBeUndefined()
  })

  it("takes its bounds from the worker rather than restating them", () => {
    expect(parse({ ...REQUIRED, maxPostings: "1" }).maxPostings).toBe(1)
    expect(
      parse({ ...REQUIRED, maxPostings: String(MAX_POSTINGS_PER_BRIEF) })
        .maxPostings
    ).toBe(MAX_POSTINGS_PER_BRIEF)

    // The ceiling is the scout's: it has to read an advertisement before it can
    // report one, so a briefing asking for more than it could read is a briefing
    // that cannot be filled.
    expect(
      rejects({ ...REQUIRED, maxPostings: String(MAX_POSTINGS_PER_BRIEF + 1) })
    ).toBe(true)
    expect(rejects({ ...REQUIRED, maxPostings: "0" })).toBe(true)
  })

  it.each(["lots", "12.5", "-3"])("rejects %s", (maxPostings) => {
    expect(rejects({ ...REQUIRED, maxPostings })).toBe(true)
  })
})
