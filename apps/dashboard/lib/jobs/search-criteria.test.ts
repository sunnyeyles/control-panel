import { describe, expect, it } from "vitest"

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

  it("accepts exactly the cap and rejects one more", () => {
    expect(
      parse({ ...REQUIRED, titles: list(MAX_CRITERIA_ITEMS) }).titles
    ).toHaveLength(MAX_CRITERIA_ITEMS)

    // Not validation for its own sake: the cap is what stops one paste from
    // writing an unbounded row.
    expect(rejects({ ...REQUIRED, titles: list(MAX_CRITERIA_ITEMS + 1) })).toBe(
      true
    )
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
