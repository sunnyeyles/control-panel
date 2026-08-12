import { describe, expect, it } from "vitest"

import type { ApifyBoardSpec } from "./apify-search.ts"
import { INDEED_SPEC } from "./indeed-search.ts"
import { LINKEDIN_SPEC } from "./linkedin-search.ts"
import { JOB_BOARDS } from "./registry.ts"
import { SEEK_SPEC } from "./seek-search.ts"

/**
 * What every board's spec must satisfy, whichever board it is.
 *
 * The three suites beside this one cover what makes each board *different* —
 * SEEK's markdown-then-text description, Indeed's post-fetch freshness filter,
 * LinkedIn's composed search URL — and `apify-search.test.ts` covers the shared
 * runner. Between them sat a gap: the invariants that hold for all three and
 * are stated only in prose, repeated once per file, where a fourth board can
 * copy the comment and not the behaviour.
 *
 * Every assertion below is one of those comments turned into a check. A new
 * board inherits all of them by appearing in {@link JOB_BOARDS}.
 */

/** A spec's own field says which board it is; the registry says it is wired. */
const SPECS: Record<string, ApifyBoardSpec<never>> = {
  SEEK: SEEK_SPEC as ApifyBoardSpec<never>,
  Indeed: INDEED_SPEC as ApifyBoardSpec<never>,
  LinkedIn: LINKEDIN_SPEC as ApifyBoardSpec<never>,
}

describe("the registry and the specs agree", () => {
  it("names a spec for every board the scout searches", () => {
    expect(Object.keys(SPECS).sort()).toEqual(
      JOB_BOARDS.map((board) => board.name).sort()
    )
  })

  it("gives each row the tool name its spec declares", () => {
    for (const board of JOB_BOARDS) {
      expect(board.toolName).toBe(SPECS[board.name]?.toolName)
    }
  })

  it("gives a fetchByUrl exactly to the boards whose spec has a byUrl", () => {
    for (const board of JOB_BOARDS) {
      expect(
        Boolean(board.fetchByUrl),
        `${board.name}: fetchByUrl and spec.byUrl disagree`
      ).toBe(Boolean(SPECS[board.name]?.byUrl))
    }
  })
})

describe.each(Object.entries(SPECS))("%s's spec", (board, spec) => {
  it("names the board the empty-result sentence renders", () => {
    expect(spec.board).toBe(board)
  })

  it("declares bounds a clamp can satisfy", () => {
    expect(spec.defaultMaxResults).toBeGreaterThan(0)
    expect(spec.maxResultsLimit).toBeGreaterThanOrEqual(spec.defaultMaxResults)
    expect(spec.defaultDaysOld).toBeGreaterThan(0)
  })

  it("keeps any actor floor at or under its own ceiling", () => {
    // A floor above the ceiling would make every search ask for more than it
    // may return, so the slice would silently drop real results on every call.
    if (spec.minItemsPerRun === undefined) return
    expect(spec.minItemsPerRun).toBeLessThanOrEqual(spec.maxResultsLimit)
  })

  /**
   * A community scraper omits fields, and the catalog — not the board — decides
   * what an incomplete posting means. `toPosting` must therefore survive an
   * item with nothing in it and answer with no URL, because a posting with no
   * URL is precisely what `PostingCatalog.record` drops.
   */
  it("renders an empty actor item without throwing, and without a URL", () => {
    const posting = spec.toPosting({} as never)

    expect(posting.url).toBeUndefined()
    expect(posting.title).toBeUndefined()
  })

  it("asks the actor for what the resolved search says, not for a default", () => {
    const body = spec.buildRequestBody({
      query: "typescript",
      maxResults: 7,
      count: 11,
      daysOld: 3,
    })

    // Whichever key each actor spells it with, the count that reaches the wire
    // is the resolved `count` — the floor-aware number — and never `maxResults`.
    expect(JSON.stringify(body)).toContain("11")
    expect(JSON.stringify(body)).toContain("typescript")
  })
})

/**
 * The by-URL body is where a single link can quietly become a crawl.
 *
 * Both actors that accept `startUrls` treat it as an *alternative* to a search,
 * so a search field sent alongside gives the actor two jobs and the second one
 * is unbounded. Three files say so in a comment; this is the check.
 */
describe.each(
  Object.entries(SPECS).filter(([, spec]) => spec.byUrl !== undefined)
)("%s's by-URL body", (_board, spec) => {
  const body = spec.byUrl!.buildRequestBody(
    "https://boards.example.com/job/123"
  )

  it("carries the URL it was given", () => {
    expect(JSON.stringify(body)).toContain("https://boards.example.com/job/123")
  })

  it("sends no search field beside it", () => {
    for (const field of [
      "searchQuery",
      "position",
      "keywords",
      "urls",
      "daysOld",
      "sortMode",
      "workType",
    ]) {
      expect(
        body,
        `${field} would turn one link into a crawl`
      ).not.toHaveProperty(field)
    }
  })

  it("bounds what a URL that is not a job page can return", () => {
    const bounds = ["maxItems", "maxItemsPerSearch", "count"]
      .map((key) => body[key])
      .filter((value): value is number => typeof value === "number")

    expect(bounds.length, "no item bound on the by-URL body").toBeGreaterThan(0)
    for (const bound of bounds) expect(bound).toBeLessThanOrEqual(1)
  })
})
