import { describe, expect, it } from "vitest"

import {
  MAX_PAGE,
  nextDirectionFor,
  pageHref,
  parsePostingQuery,
  postingsHref,
  sortHref,
} from "./posting-query"

/**
 * The app's first reader of untrusted GET input, so most of this is about what
 * happens to values nobody would type on purpose.
 */

describe("parsePostingQuery", () => {
  it("defaults to the most recently seen, first page", () => {
    expect(parsePostingQuery()).toEqual({
      sort: "lastSeen",
      direction: "desc",
      page: 1,
    })
    expect(parsePostingQuery({})).toEqual(parsePostingQuery())
  })

  it("reads a sort, a direction and a page", () => {
    expect(
      parsePostingQuery({ sort: "title", dir: "desc", page: "4" })
    ).toEqual({ sort: "title", direction: "desc", page: 4 })
  })

  /**
   * ⚠️ The reason this parses per field rather than with one `safeParse`: a
   * whole-object parse fails as a unit, so the sort would be thrown away
   * because the number beside it was nonsense.
   */
  it.each([
    ["abc", "not a number"],
    ["0", "before the first page"],
    ["-1", "negative"],
    ["", "empty"],
    ["1.5", "fractional"],
    [String(MAX_PAGE + 1), "past the cap"],
  ])("falls back on page=%s (%s) while keeping the sort", (page) => {
    expect(parsePostingQuery({ sort: "company", page })).toEqual({
      sort: "company",
      direction: "asc",
      page: 1,
    })
  })

  /**
   * A date's interesting end is the recent one, which is why the Posted column
   * runs the same way `lastSeen` does rather than the way the two name columns
   * beside it do.
   */
  it("reads the posting date sort, newest first by default", () => {
    expect(parsePostingQuery({ sort: "posted" })).toEqual({
      sort: "posted",
      direction: "desc",
      page: 1,
    })
    expect(parsePostingQuery({ sort: "posted", dir: "asc" }).direction).toBe(
      "asc"
    )
  })

  it("falls back on an unknown sort while keeping a valid page", () => {
    expect(parsePostingQuery({ sort: "salary", page: "3" })).toEqual({
      sort: "lastSeen",
      direction: "desc",
      page: 3,
    })
  })

  it("falls back on an unknown direction to the column's own default", () => {
    expect(parsePostingQuery({ sort: "title", dir: "sideways" })).toEqual({
      sort: "title",
      direction: "asc",
      page: 1,
    })
    expect(parsePostingQuery({ dir: "sideways" }).direction).toBe("desc")
  })

  /** `?page=1&page=2` is legal, and Next reports it as an array. */
  it("takes the first value of a repeated parameter", () => {
    expect(
      parsePostingQuery({ page: ["2", "9"], sort: ["title", "company"] })
    ).toEqual({ sort: "title", direction: "asc", page: 2 })
  })

  it("survives an array where a scalar was expected and a bad value inside it", () => {
    expect(parsePostingQuery({ page: ["abc"], sort: ["company"] })).toEqual({
      sort: "company",
      direction: "asc",
      page: 1,
    })
  })
})

describe("postingsHref", () => {
  /** The canonical first page is a URL somebody would actually share. */
  it("omits every default", () => {
    expect(postingsHref({ sort: "lastSeen", direction: "desc", page: 1 })).toBe(
      "/jobs"
    )
  })

  it("keeps a non-default direction even on the default sort", () => {
    expect(postingsHref({ sort: "lastSeen", direction: "asc", page: 1 })).toBe(
      "/jobs?dir=asc"
    )
  })

  it("omits a direction that is the column's own default", () => {
    expect(postingsHref({ sort: "title", direction: "asc", page: 1 })).toBe(
      "/jobs?sort=title"
    )
  })

  it.each([
    { sort: "company", direction: "desc", page: 3 },
    // The reversed posting-date order: a sort whose default direction is `desc`
    // and a `dir` that therefore has to survive the round trip.
    { sort: "posted", direction: "asc", page: 1 },
  ] as const)("round-trips $sort/$direction through the parser", (view) => {
    expect(
      parsePostingQuery(
        Object.fromEntries(
          new URL(postingsHref(view), "https://example.test").searchParams
        )
      )
    ).toEqual(view)
  })
})

describe("sortHref", () => {
  const current = { sort: "title", direction: "asc", page: 4 } as const

  /**
   * Page 3 of one order has no relationship to page 3 of another, so the row
   * someone was looking at is not on the page they would land on.
   */
  it("resets the page", () => {
    expect(sortHref("company", current)).toBe("/jobs?sort=company")
  })

  it("flips the column already sorted", () => {
    expect(sortHref("title", current)).toBe("/jobs?sort=title&dir=desc")
  })

  it("starts another column at its own natural end", () => {
    expect(nextDirectionFor("lastSeen", current)).toBe("desc")
    expect(nextDirectionFor("company", current)).toBe("asc")
    expect(nextDirectionFor("title", current)).toBe("desc")
  })
})

describe("pageHref", () => {
  it("keeps the order and changes only the page", () => {
    expect(pageHref(2, { sort: "company", direction: "desc", page: 1 })).toBe(
      "/jobs?sort=company&dir=desc&page=2"
    )
  })
})
