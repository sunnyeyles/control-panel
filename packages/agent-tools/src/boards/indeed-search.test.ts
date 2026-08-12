import { beforeEach, describe, expect, it } from "vitest"

import {
  apifyIndeedSearch,
  INDEED_SPEC,
  type IndeedSearchDeps,
} from "./indeed-search.ts"
import type { PostingCatalog } from "./posting-catalog.ts"
import {
  API_TOKEN,
  fakeFetch,
  jsonResponse,
  requestBody,
  sequentialCatalog,
  type Capture,
} from "../test-support/search-fakes.ts"

/**
 * What is true of Indeed and of no other board: the actor it runs, the request
 * body that actor wants, which of its fields carry the title, the URL and the
 * description, and the two bounds the actor's input schema cannot take — so
 * this tool applies them to the items instead. The token handling, the clamp,
 * the failure split, the truncation and the rendering are shared, and
 * `apify-search.test.ts` owns them.
 *
 * Driven through `apifyIndeedSearch` rather than the tool wrapper, exactly as
 * `seek-search.test.ts` does it: a tool's schema describes what the *model*
 * passes and has nowhere to carry a fake `fetch`.
 */

/**
 * Ages are written relative to the run rather than as fixed dates: the
 * freshness filter reads the wall clock, and a literal timestamp would quietly
 * become "stale" and start failing these tests some weeks after they were
 * written.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** One item, shaped as the actor's dataset returns it: a bare array. */
const ONE_JOB = [
  {
    url: "https://au.indeed.com/viewjob?jk=e84cd445a1ea8a30",
    positionName: "Senior Software Engineer",
    company: "Acme",
    location: "Sydney NSW",
    description: "Build TypeScript services in a small product team.",
    postingDateParsed: daysAgo(1),
    jobType: "Full-time",
    salary: "$140,000 - $170,000 a year",
    isExpired: false,
  },
]

let catalog: PostingCatalog

beforeEach(() => {
  catalog = sequentialCatalog()
})

/** `apifyIndeedSearch` against the catalog this test is holding. */
function indeedSearch(
  input: Parameters<typeof apifyIndeedSearch>[0],
  deps: IndeedSearchDeps
): Promise<string> {
  return apifyIndeedSearch(input, catalog, deps)
}

describe("apifyIndeedSearch", () => {
  it("sends the query to Indeed's actor and renders its fields", async () => {
    const captured: Capture[] = []

    const output = await indeedSearch(
      { query: "software engineer TypeScript", location: "Sydney NSW" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toContain(
      "api.apify.com/v2/acts/misceres~indeed-scraper/run-sync-get-dataset-items"
    )

    // The whole body, as it was confirmed against a live run: the actor names
    // the search term `position`, not `query`, and takes the country separately
    // from the location.
    const body = requestBody(captured[0]!)
    expect(body).toEqual({
      position: "software engineer TypeScript",
      country: "AU",
      location: "Sydney NSW",
      maxItemsPerSearch: 20,
      saveOnlyUniqueItems: true,
      parseCompanyDetails: false,
      followApplyRedirects: false,
    })

    expect(output).toContain("[id1] Senior Software Engineer — Acme")
    expect(output).toContain(
      "Sydney NSW · Full-time · $140,000 - $170,000 a year"
    )
    expect(output).toContain("Build TypeScript services")

    // The URL is the traceability requirement — a result the brief cannot link
    // to is not usable downstream — and it is kept in the catalog rather than
    // put in front of the model.
    expect(output).not.toContain("https://au.indeed.com")
    expect(catalog.get("id1")).toMatchObject({
      board: "Indeed",
      url: "https://au.indeed.com/viewjob?jk=e84cd445a1ea8a30",
    })
  })

  it("records the canonical URL and never the tracking-laden apply link", async () => {
    const withApplyLink = [
      {
        ...ONE_JOB[0],
        externalApplyLink:
          "https://au.indeed.com/applystart?jk=e84cd445a1ea8a30&from=vjs&tk=1j0abc&vjk=e84cd445a1ea8a30",
      },
    ]

    await indeedSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(withApplyLink), []) }
    )

    // Posting identity downstream is derived from the URL, so the same
    // advertisement reached twice with different `from`/`tk`/`vjk` values would
    // become two postings — and now two catalog entries, so two ids for one
    // role. `url` is the stable `viewjob?jk=` form; the apply link is not, and
    // nothing here may read it.
    expect(catalog.get("id1")?.url).toBe(
      "https://au.indeed.com/viewjob?jk=e84cd445a1ea8a30"
    )
  })

  it("declares bounds under SEEK's, because the inventory is thinner", () => {
    // The clamp that applies them is shared and `apify-search.test.ts` drives
    // it; what is Indeed's alone are the numbers. Under SEEK's 40 because the
    // actor charges per item and Indeed's Australian inventory is thinner.
    expect(INDEED_SPEC.defaultMaxResults).toBe(20)
    expect(INDEED_SPEC.maxResultsLimit).toBe(25)
  })

  it("scopes an unspecified location by country rather than inventing one", async () => {
    const captured: Capture[] = []

    await indeedSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    const body = requestBody(captured[0]!)
    expect(body).not.toHaveProperty("location")
    expect(body.country).toBe("AU")
  })

  describe("the freshness bound, which the actor cannot take", () => {
    it("filters on the posting date instead of sending a bound", async () => {
      const captured: Capture[] = []
      const mixed = [
        { ...ONE_JOB[0], positionName: "Fresh", postingDateParsed: daysAgo(2) },
        {
          ...ONE_JOB[0],
          positionName: "Stale",
          postingDateParsed: daysAgo(40),
        },
      ]

      const output = await indeedSearch(
        { query: "a", daysOld: 7 },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(mixed), captured) }
      )

      // The actor's input schema has no freshness field at all, so sending one
      // would be silently ignored and the bound would look enforced without
      // being enforced. Nothing recency-shaped may appear in the body.
      const body = requestBody(captured[0]!)
      for (const key of Object.keys(body)) {
        expect(key).not.toMatch(/day|date|since|recen|fresh|age/i)
      }

      expect(output).toContain("Fresh")
      expect(output).not.toContain("Stale")
    })

    it("keeps a posting whose date is missing or will not parse", async () => {
      // Distinct URLs, because these are distinct advertisements: the catalog
      // gives one entry per posting, so two items sharing a URL render once.
      const undated = [
        {
          ...ONE_JOB[0],
          url: "https://au.indeed.com/viewjob?jk=1111111111111111",
          positionName: "Undated",
          postingDateParsed: undefined,
        },
        {
          ...ONE_JOB[0],
          url: "https://au.indeed.com/viewjob?jk=2222222222222222",
          positionName: "Garbled",
          postingDateParsed: "soon",
        },
      ]

      const output = await indeedSearch(
        { query: "a", daysOld: 7 },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(undated), []) }
      )

      // The actor returns only live listings, so a missing timestamp is a
      // defect in a community scraper rather than evidence the advertisement is
      // old. Dropping on absence would let one upstream field change silently
      // empty every search — and quietly, which is the worse failure. What the
      // model sees instead is a stanza with no `listed:` line, so the missing
      // evidence is visible to it. Neither posting gets one: a date this tool
      // could not read is not a date it may show, so "soon" is dropped rather
      // than rendered as though it were a listing date.
      expect(output).toContain("Undated")
      expect(output).toContain("Garbled")
      expect(output).not.toContain("listed:")
    })
  })

  describe("the employment type, which the actor cannot take either", () => {
    it("filters on the returned jobType instead of sending one", async () => {
      const captured: Capture[] = []
      const mixed = [
        { ...ONE_JOB[0], positionName: "A contract role", jobType: "Contract" },
        {
          ...ONE_JOB[0],
          positionName: "A full-time role",
          jobType: "Full-time",
        },
      ]

      const output = await indeedSearch(
        { query: "a", workType: "Contract" },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(mixed), captured) }
      )

      // Same reasoning as the freshness bound: the run below takes `position`,
      // `country`, `location` and item bounds and nothing about employment
      // type, so the bound is honoured on the way out rather than pretended at
      // on the way in.
      const body = requestBody(captured[0]!)
      for (const key of Object.keys(body)) {
        expect(key).not.toMatch(/type|contract|employment/i)
      }

      expect(output).toContain("A contract role")
      expect(output).not.toContain("A full-time role")
    })

    it("keeps a posting that stated no type at all", async () => {
      const untyped = [
        { ...ONE_JOB[0], positionName: "Unstated", jobType: undefined },
      ]

      const output = await indeedSearch(
        { query: "a", workType: "Contract" },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(untyped), []) }
      )

      // `jobType` is present only when the advertisement stated one, so an
      // absent value means unknown and not "some other type". Only a posting
      // the actor labelled something else is dropped.
      expect(output).toContain("Unstated")
    })
  })

  it("drops a posting the actor has flagged as expired", async () => {
    const closed = [
      { ...ONE_JOB[0], positionName: "Closed", isExpired: true },
      { ...ONE_JOB[0], positionName: "Open", isExpired: false },
    ]

    const output = await indeedSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(closed), []) }
    )

    // The rendering announces "currently-listed posting(s)". An advertisement
    // Indeed has already closed would make that sentence false, and would send
    // the scout's reader to a dead page.
    expect(output).toContain("Open")
    expect(output).not.toContain("Closed")
  })

  it("declares the board name the empty-result sentence renders", () => {
    // The sentence itself is `formatSearchResults`'s, owned by
    // `apify-search.test.ts`. What is Indeed's alone is the spelling.
    expect(INDEED_SPEC.board).toBe("Indeed")
  })
})
