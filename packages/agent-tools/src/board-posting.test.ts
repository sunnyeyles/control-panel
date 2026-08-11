import { describe, expect, it } from "vitest"

import { allTools } from "./index.ts"
import { fetchBoardPosting, type BoardPostingDeps } from "./board-posting.ts"
import { INDEED_SPEC } from "./indeed-search.ts"
import { LINKEDIN_SPEC } from "./linkedin-search.ts"
import { SEEK_SPEC } from "./seek-search.ts"
import {
  API_TOKEN,
  fakeFetch,
  jsonResponse,
  requestBody,
  type Capture,
} from "./test-support/search-fakes.ts"

/**
 * Fetching one advertisement from the board that serves it.
 *
 * The two properties worth more than the happy path:
 *
 * 1. **The item has to be the advertisement that was asked for.** Both actors
 *    accept a search or a company page as a start URL and would answer either
 *    with a list of other postings, so the identity check is the only thing
 *    between "somebody pasted a search page" and "an arbitrary role was stored
 *    as though they had chosen it".
 * 2. **No board fetcher is a tool.** Same rule as `page-extract.ts`, asserted
 *    the same way, and for the same reason: `tool()` around either of them puts
 *    an arbitrary fetcher in the hands of whichever agent picks it up.
 */

/**
 * A stand-in for `postingId()`, which lives in `@workspace/agents` and cannot be
 * reached from here — which is the whole reason `idFor` is injected.
 *
 * It reproduces the one property the check depends on: two links to the same
 * advertisement that differ only in tracking decoration are one id.
 */
function idFor(url: string): string {
  const parsed = new URL(url)
  return `${parsed.hostname}${parsed.pathname}`
}

const SEEK_URL = "https://www.seek.com.au/job/93431609"

const SEEK_ITEM = {
  title: "Senior Backend Engineer",
  company: "Holloway Labs",
  location: "Sydney NSW",
  url: SEEK_URL,
  publishDateISO: "2026-08-04T02:11:00.000Z",
  teaser: "Own the data platform behind a product used by half the country.",
  bulletPoints: ["TypeScript and Postgres", "Hybrid, two days in the office"],
  descriptionMarkdown: "## About the role\n\nA long advertisement.",
}

const INDEED_URL = "https://au.indeed.com/viewjob?jk=8f21c0d5aa11be32"

const INDEED_ITEM = {
  url: INDEED_URL,
  positionName: "Platform Engineer",
  company: "Northbay",
  location: "Melbourne VIC",
  postingDateParsed: "2026-08-03T00:50:35.310Z",
  description:
    "We are hiring a platform engineer to look after our deployment pipeline.",
}

function deps(captured: Capture[], reply: Response | Error): BoardPostingDeps {
  return { fetch: fakeFetch(reply, captured), apiToken: API_TOKEN, idFor }
}

describe("fetchBoardPosting", () => {
  it("reads SEEK's own fields into a Posting, with no model anywhere", async () => {
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(captured, jsonResponse([SEEK_ITEM]))
    )

    expect(result).toEqual({
      status: "fetched",
      posting: {
        board: "SEEK",
        title: "Senior Backend Engineer",
        company: "Holloway Labs",
        location: "Sydney NSW",
        summary:
          "Own the data platform behind a product used by half the country.",
        postedAt: "2026-08-04T02:11:00.000Z",
        highlights: [
          "TypeScript and Postgres",
          "Hybrid, two days in the office",
        ],
      },
    })
  })

  /**
   * The run has to be a fetch and not a search. A `searchQuery` beside a start
   * URL is how one link becomes a crawl — and the actor would answer it, which
   * is what makes this worth pinning rather than trusting.
   */
  it("asks SEEK for that one listing and sends it no search", async () => {
    const captured: Capture[] = []

    await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(captured, jsonResponse([SEEK_ITEM]))
    )

    const body = requestBody(captured[0]!)

    expect(body.startUrls).toEqual([{ url: SEEK_URL }])
    expect(body.maxItems).toBe(1)
    // Without it the actor returns `descriptionMarkdown: null`, and a Posting
    // stored from a link would carry the teaser and nothing else.
    expect(body.fetchDetails).toBe(true)
    expect(body).not.toHaveProperty("searchQuery")
    expect(body).not.toHaveProperty("daysOld")
    expect(body).not.toHaveProperty("sortMode")
  })

  it("falls through empty markdown to plain text on the by-URL path", async () => {
    // Same rule as search/`toPosting`: the actor returns `""` for a blank
    // description, and `??` would let that block the text fallback.
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(
        captured,
        jsonResponse([
          {
            ...SEEK_ITEM,
            teaser: undefined,
            descriptionMarkdown: "",
            descriptionText:
              "We need someone who has shipped Postgres migrations.",
          },
        ])
      )
    )

    expect(result).toMatchObject({
      status: "fetched",
      posting: {
        summary: expect.stringContaining("shipped Postgres migrations"),
      },
    })
  })

  /**
   * Thirty seconds rather than the search path's hundred and twenty. A person is
   * waiting on this one, inside a route whose `maxDuration` is 60.
   */
  it("bounds the run well inside the route that is waiting on it", async () => {
    const captured: Capture[] = []

    await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(captured, jsonResponse([SEEK_ITEM]))
    )

    expect(captured[0]!.url).toContain(
      "unfenced-group~seek-com-au-scraper/run-sync-get-dataset-items"
    )
    expect(captured[0]!.url).toContain("timeout=30")
  })

  it("reads Indeed's fields, and its summary off the head of the description", async () => {
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      INDEED_SPEC,
      INDEED_URL,
      deps(captured, jsonResponse([INDEED_ITEM]))
    )

    expect(result).toEqual({
      status: "fetched",
      posting: {
        board: "Indeed",
        title: "Platform Engineer",
        company: "Northbay",
        location: "Melbourne VIC",
        // Indeed publishes no teaser, so the advertisement's opening stands in.
        summary: INDEED_ITEM.description,
        postedAt: "2026-08-03T00:50:35.310Z",
      },
    })

    const body = requestBody(captured[0]!)
    expect(body.startUrls).toEqual([{ url: INDEED_URL }])
    expect(body.maxItemsPerSearch).toBe(1)
    expect(body).not.toHaveProperty("position")
  })

  /**
   * ⚠️ The case the identity check exists for. A search URL is a legal
   * `startUrls` entry on both actors, and what comes back is other people's
   * postings — every one of them a plausible-looking result that nobody chose.
   */
  it("refuses a result that is not the advertisement that was asked for", async () => {
    const captured: Capture[] = []
    const somewhereElse = "https://www.seek.com.au/job/11111111"

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(
        captured,
        jsonResponse([{ ...SEEK_ITEM, url: somewhereElse, title: "Something" }])
      )
    )

    expect(result.status).toBe("failed")
    expect(result.status === "failed" && result.message).toMatch(
      /did not resolve to a single job advertisement/i
    )
  })

  /**
   * The other half of the same rule: the pasted link and the board's canonical
   * one are the same advertisement, and tracking decoration must not make them
   * two. `idFor` is the platform's identity in production; here it is the stub
   * above, which normalises the same way.
   */
  it("accepts the board's canonical link for a pasted one that carries tracking", async () => {
    const captured: Capture[] = []
    const pasted = `${SEEK_URL}?type=standard&ref=search-standalone`

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      pasted,
      deps(captured, jsonResponse([SEEK_ITEM]))
    )

    expect(result.status).toBe("fetched")
    // The run was asked for the link the user actually pasted.
    expect(requestBody(captured[0]!).startUrls).toEqual([{ url: pasted }])
  })

  it("picks the right advertisement out of several", async () => {
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(
        captured,
        jsonResponse([
          {
            ...SEEK_ITEM,
            url: "https://www.seek.com.au/job/222",
            title: "One",
          },
          SEEK_ITEM,
          {
            ...SEEK_ITEM,
            url: "https://www.seek.com.au/job/333",
            title: "Three",
          },
        ])
      )
    )

    expect(result.status === "fetched" && result.posting.title).toBe(
      "Senior Backend Engineer"
    )
  })

  it("says nothing came back for an empty run", async () => {
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(captured, jsonResponse([]))
    )

    expect(result.status).toBe("failed")
    expect(result.status === "failed" && result.message).toMatch(
      /returned nothing for that link/i
    )
  })

  /**
   * `company` and `location` take the substitute the extractor's own schema
   * prescribes for a page that does not say. `title` has none — it is what the
   * table renders and what every message names the Posting by.
   */
  it('fills an absent company and location with "Unknown"', async () => {
    const captured: Capture[] = []
    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(
        captured,
        jsonResponse([{ ...SEEK_ITEM, company: undefined, location: "  " }])
      )
    )

    expect(result.status === "fetched" && result.posting.company).toBe(
      "Unknown"
    )
    expect(result.status === "fetched" && result.posting.location).toBe(
      "Unknown"
    )
  })

  it("refuses an item with no title rather than storing a nameless row", async () => {
    const captured: Capture[] = []
    const untitled = { ...SEEK_ITEM, title: undefined }

    const result = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(captured, jsonResponse([untitled]))
    )

    expect(result.status).toBe("failed")
  })

  it("drops an unreadable listing date rather than storing one", async () => {
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      INDEED_SPEC,
      INDEED_URL,
      deps(
        captured,
        jsonResponse([{ ...INDEED_ITEM, postingDateParsed: "soon" }])
      )
    )

    expect(result.status === "fetched" && result.posting).not.toHaveProperty(
      "postedAt"
    )
  })

  /**
   * LinkedIn's actor accepts search-results URLs and has no input for a single
   * job page, so it carries no `byUrl` at all. The caller turns this into a fall
   * through to the general page fetcher — and nothing is spent finding out.
   */
  it("reports LinkedIn as unsupported without making a request", async () => {
    const captured: Capture[] = []

    const result = await fetchBoardPosting(
      LINKEDIN_SPEC,
      "https://www.linkedin.com/jobs/view/4012345678",
      deps(captured, jsonResponse([]))
    )

    expect(result).toEqual({ status: "unsupported" })
    expect(captured).toHaveLength(0)
  })

  /**
   * A rejected token is a deployment fault no retry fixes, so it throws and the
   * caller reports "something went wrong" rather than blaming a link that is
   * fine. Same split as every other call in this package.
   */
  it("throws on a rejected token and answers on every other HTTP failure", async () => {
    const captured: Capture[] = []

    await expect(
      fetchBoardPosting(
        SEEK_SPEC,
        SEEK_URL,
        deps(captured, jsonResponse({}, 401))
      )
    ).rejects.toThrow(/APIFY_TOKEN/)

    const failed = await fetchBoardPosting(
      SEEK_SPEC,
      SEEK_URL,
      deps(captured, jsonResponse({}, 503))
    )

    expect(failed.status).toBe("failed")
    expect(failed.status === "failed" && failed.message).toContain(
      "That SEEK link"
    )
  })
})

/**
 * The same assertion `page-extract.test.ts` makes about the other fetcher, and
 * it is here for the same reason: a test is what stops the next person wrapping
 * `tool()` around this and handing an arbitrary fetcher to the general
 * assistant, which carries `allTools`.
 */
describe("the board fetcher is not a tool", () => {
  it("is absent from the catalog", () => {
    expect(allTools.map((held) => held.name)).toEqual([
      "get_current_time",
      "web_search",
    ])
  })

  it("is a plain function with no schema to invoke", () => {
    expect(fetchBoardPosting).not.toHaveProperty("schema")
    expect(fetchBoardPosting).not.toHaveProperty("invoke")
  })
})
