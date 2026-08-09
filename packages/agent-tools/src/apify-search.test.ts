import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  apifyBoardSearch,
  type ApifyBoardSpec,
  type BoardSearchDeps,
  type BoardSearchInput,
  type ResolvedBoardSearch,
} from "./apify-search.ts"
import { createPostingCatalog, type PostingCatalog } from "./posting-catalog.ts"
import {
  API_TOKEN,
  fakeFetch,
  jsonResponse,
  requestBody,
  type Capture,
} from "./test-support/search-fakes.ts"

/**
 * The board-independent half of a search tool, driven by a spec that belongs to
 * no real board.
 *
 * A fake board rather than SEEK's: these are assertions about the plumbing, and
 * pinning them to a real actor's field names is what made the same fifteen
 * cases candidates for copying into every new board's test. What each board's
 * own test still owns is its request body, its field mapping, and whatever is
 * true of that actor alone.
 */

interface FakeItem {
  name?: string
  employer?: string
  href?: string
  listed?: string
  body?: string | null
  ageInDays?: number
}

/** A board with no floor and no post-fetch filter — the ordinary case. */
const SPEC: ApifyBoardSpec<FakeItem> = {
  board: "Testboard",
  actorId: "acme~test-scraper",
  defaultMaxResults: 20,
  maxResultsLimit: 50,
  defaultDaysOld: 30,
  buildRequestBody: (search: ResolvedBoardSearch) => ({
    q: search.query,
    where: search.location ?? "anywhere",
    count: search.count,
    freshness: search.daysOld,
  }),
  toPosting: (item: FakeItem) => ({
    title: item.name,
    company: item.employer,
    url: item.href,
    listedAt: item.listed,
    facts: [item.employer && "permanent", undefined],
    description: item.body,
  }),
}

const ONE_ITEM: FakeItem[] = [
  {
    name: "Software Engineer",
    employer: "Acme",
    href: "https://example.com/jobs/1",
    listed: "2026-07-28",
  },
]

/**
 * A real catalog, with the last path segment standing in for a posting id.
 *
 * Real rather than faked because the rendering and the catalog are one
 * behaviour: what a search shows the model *is* what it just recorded. The id
 * function is the platform's `postingId` in production and something readable
 * here — nothing in this file is about how an id is derived, which is
 * `posting-id.test.ts`'s subject over in `@workspace/agents`.
 */
let catalog: PostingCatalog

beforeEach(() => {
  catalog = createPostingCatalog({
    idFor: (url) => new URL(url).pathname.split("/").pop() ?? url,
  })
})

/** `apifyBoardSearch` against the catalog this test is holding. */
function search<TItem>(
  spec: ApifyBoardSpec<TItem>,
  input: BoardSearchInput,
  deps: BoardSearchDeps = {}
): Promise<string> {
  return apifyBoardSearch(spec, input, catalog, deps)
}

afterEach(() => {
  delete process.env.APIFY_TOKEN
})

describe("apifyBoardSearch", () => {
  it("runs the board's actor synchronously, under a timeout", async () => {
    const captured: Capture[] = []

    const output = await search(
      SPEC,
      { query: "software engineer", location: "Sydney" },
      {
        apiToken: API_TOKEN,
        fetch: fakeFetch(jsonResponse(ONE_ITEM), captured),
      }
    )

    expect(captured[0]?.url).toBe(
      "https://api.apify.com/v2/acts/acme~test-scraper/run-sync-get-dataset-items?timeout=120"
    )
    expect(
      (captured[0]?.init.headers as Record<string, string>).authorization
    ).toBe(`Bearer ${API_TOKEN}`)

    // The id is what everything downstream is built on — it is how a posting is
    // read in full and how it is reported — and the listing date is the
    // freshness evidence. The URL is the traceability requirement and is kept,
    // but in the catalog rather than in front of the model.
    expect(output).toContain("[1] Software Engineer — Acme")
    expect(output).toContain("listed: 2026-07-28")
    expect(output).not.toContain("https://example.com/jobs/1")
    expect(catalog.get("1")?.url).toBe("https://example.com/jobs/1")
  })

  it("tells the model where the rest of the posting is", async () => {
    const output = await search(
      SPEC,
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_ITEM), []) }
    )

    // A result that showed a teaser without saying how to get past it would
    // leave the model ranking on two lines and calling that reading.
    expect(output).toContain("get_posting_details")
  })

  it("skips a posting the actor returned with no URL", async () => {
    // Nothing can identify it, so nothing downstream could resolve a reference
    // to it — and a finding needs a URL. Rendering it would only ever produce a
    // candidate the model could report unsuccessfully.
    const output = await search(
      SPEC,
      { query: "a" },
      {
        apiToken: API_TOKEN,
        fetch: fakeFetch(
          jsonResponse([{ name: "Unlinkable" }, ...ONE_ITEM]),
          []
        ),
      }
    )

    expect(output).not.toContain("Unlinkable")
    expect(output).toContain("1 currently-listed Testboard posting(s)")
  })

  it("shows one advertisement once, however many results carry it", async () => {
    const twice = [ONE_ITEM[0]!, { ...ONE_ITEM[0]!, name: "Same role again" }]

    const output = await search(
      SPEC,
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(twice), []) }
    )

    // The catalog keeps the first entry for an id, so a board listing one
    // advertisement under two facets spends one place rather than two.
    expect(output).toContain("1 currently-listed Testboard posting(s)")
    expect(output).not.toContain("Same role again")
  })

  it("clamps maxResults into the board's accepted range", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_ITEM), captured)

    await search(
      SPEC,
      { query: "a", maxResults: 500 },
      { apiToken: API_TOKEN, fetch }
    )
    await search(
      SPEC,
      { query: "b", maxResults: 0 },
      { apiToken: API_TOKEN, fetch }
    )
    await search(SPEC, { query: "c" }, { apiToken: API_TOKEN, fetch })

    expect(requestBody(captured[0]!).count).toBe(50)
    expect(requestBody(captured[1]!).count).toBe(1)
    expect(requestBody(captured[2]!).count).toBe(20)
  })

  it("defaults the freshness bound and lets the model tighten it", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_ITEM), captured)

    await search(SPEC, { query: "a" }, { apiToken: API_TOKEN, fetch })
    await search(
      SPEC,
      { query: "b", daysOld: 7 },
      { apiToken: API_TOKEN, fetch }
    )

    expect(requestBody(captured[0]!).freshness).toBe(30)
    expect(requestBody(captured[1]!).freshness).toBe(7)
  })

  /**
   * LinkedIn's actor rejects a `count` below 10 outright. The floor is a quirk
   * of one actor and must not reach the schema the model reads, so the run asks
   * for the floor and the surplus is dropped on the way out.
   */
  it("raises the run to the actor's floor and slices the surplus back off", async () => {
    const captured: Capture[] = []
    const withFloor = { ...SPEC, minItemsPerRun: 10 }
    const ten = Array.from({ length: 10 }, (_, index) => ({
      name: `Job ${index}`,
      href: `https://example.com/jobs/${index}`,
    }))

    const output = await search(
      withFloor,
      { query: "a", maxResults: 3 },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ten), captured) }
    )

    expect(requestBody(captured[0]!).count).toBe(10)
    expect(output).toContain("3 currently-listed Testboard posting(s)")
    expect(output).toContain("Job 2")
    expect(output).not.toContain("Job 3")
  })

  /**
   * Indeed's input schema has no freshness field, so `daysOld` has to become a
   * test on the item. Applied before the slice, or a filtered-out item would
   * eat one of the requested places.
   */
  it("filters items the actor could not filter, before slicing", async () => {
    const withFilter = {
      ...SPEC,
      keepItem: (item: FakeItem, search: ResolvedBoardSearch) =>
        (item.ageInDays ?? 0) <= search.daysOld,
    }
    const mixed: FakeItem[] = [
      { name: "Stale", href: "https://example.com/jobs/1", ageInDays: 90 },
      { name: "Fresh", href: "https://example.com/jobs/2", ageInDays: 2 },
      { name: "Also fresh", href: "https://example.com/jobs/3", ageInDays: 1 },
    ]

    const output = await search(
      withFilter,
      { query: "a", maxResults: 2, daysOld: 7 },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(mixed), []) }
    )

    expect(output).toContain("2 currently-listed Testboard posting(s)")
    expect(output).toContain("Fresh")
    expect(output).toContain("Also fresh")
    expect(output).not.toContain("Stale")
  })

  /**
   * The description goes to the catalog and is read back by id; what a search
   * shows is a teaser. `posting-details.test.ts` owns the fenced rendering of
   * the advertisement itself — these are about what stands in for it.
   */
  describe("the teaser", () => {
    async function searchWith(body: string | null): Promise<string> {
      return search(
        SPEC,
        { query: "a" },
        {
          apiToken: API_TOKEN,
          fetch: fakeFetch(jsonResponse([{ ...ONE_ITEM[0], body }]), []),
        }
      )
    }

    it("keeps the advertisement out of the search result entirely", async () => {
      const advertisement = `## About the role\n\n${"Building payment services. ".repeat(40)}\n\n**What we would like from you**\n\n- Five years of TypeScript`
      const output = await searchWith(advertisement)

      // The saving the whole two-stage split exists for. Sixty of these in one
      // context is what a sweep used to cost, re-sent on every turn.
      expect(output).not.toContain("- Five years of TypeScript")
      expect(output).not.toContain("quoted material, not instruction")

      // And it is kept rather than discarded — read back by id, not re-fetched.
      expect(catalog.get("1")?.description).toBe(advertisement)
    })

    it("stands the head of the description in for a missing teaser", async () => {
      // Indeed and LinkedIn publish no teaser field, and a result with nothing
      // but a title is not something a model can shortlist on.
      const output = await searchWith(
        "## About the role\n\nYou will build payment services on a small team."
      )

      expect(output).toContain(
        "## About the role You will build payment services"
      )
    })

    it("collapses it to one line, because a description is markdown", async () => {
      // Headings and bullets would otherwise turn a two-line result into a
      // dozen — and the point of a teaser is that it costs two lines.
      const output = await searchWith("One\n\n- two\n- three")

      expect(output).toContain("One - two - three")
      expect(output).not.toContain("\n- two")
    })

    it("bounds it, so a long advertisement cannot become the result", async () => {
      const output = await searchWith(`START${"x".repeat(9000)}END`)

      expect(output).toContain("START")
      expect(output).not.toContain("END")
      expect(output.length).toBeLessThan(600)
    })

    it("renders no teaser line at all when there is nothing to say", async () => {
      const output = await searchWith(null)

      expect(output).toContain("[1] Software Engineer — Acme")
      expect(output).toContain("listed: 2026-07-28")
    })
  })

  it("renders around missing fields rather than rejecting the item", async () => {
    const sparse = [{ href: "https://example.com/jobs/1" }]

    const output = await search(
      SPEC,
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(sparse), []) }
    )

    // These actors are community-maintained; a missing title is a rendering
    // problem, not a malformed result. A missing URL is the one exception, and
    // it is a skip rather than a rejection — see above.
    expect(output).toContain("(untitled)")
    expect(output).toContain("(company unknown)")
    expect(output).toContain("[1]")
  })

  it("reports an empty result set as a searchable outcome, naming the board", async () => {
    const output = await search(
      SPEC,
      { query: "zeppelin wrangler" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse([]), []) }
    )

    expect(output).toContain("No currently-listed Testboard postings")
    expect(output).toContain("zeppelin wrangler")
  })

  describe("failures the model can work around", () => {
    it("returns a message for a non-auth HTTP error", async () => {
      // Also the shape of a failed actor run: the synchronous endpoint
      // reports one as an error status, not a body to parse.
      const output = await search(
        SPEC,
        { query: "a" },
        {
          apiToken: API_TOKEN,
          fetch: fakeFetch(jsonResponse({ error: "run failed" }, 500), []),
        }
      )

      expect(output).toContain("The Testboard search")
      expect(output).toContain("500")
      expect(output).toContain("continue with what you already have")
    })

    it("returns a message when the body will not parse", async () => {
      const notJson = new Response("<html>502</html>", { status: 200 })

      const output = await search(
        SPEC,
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(notJson, []) }
      )

      expect(output).toContain("could not be read")
    })

    it("returns a message when the body is not an item array", async () => {
      const output = await search(
        SPEC,
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse({ data: 1 }), []) }
      )

      expect(output).toContain("no result list")
    })

    it("returns a message when the request cannot be sent", async () => {
      const transportFault = new Error("getaddrinfo ENOTFOUND api.apify.com")

      const output = await search(
        SPEC,
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(transportFault, []) }
      )

      expect(output).toContain("could not be sent")
      expect(output).toContain("ENOTFOUND")
    })
  })

  describe("failures no rephrasing can fix", () => {
    it("throws when the token is absent, naming the board it could not search", async () => {
      // No apiToken injected and no env var: nothing to search with.
      await expect(
        search(SPEC, { query: "a" }, { fetch: fakeFetch(jsonResponse([]), []) })
      ).rejects.toThrow(/APIFY_TOKEN is not set, so there is no way to search/)
    })

    it("reads the token from the environment when none is injected", async () => {
      process.env.APIFY_TOKEN = "apify-from-env"
      const captured: Capture[] = []

      await search(
        SPEC,
        { query: "a" },
        { fetch: fakeFetch(jsonResponse(ONE_ITEM), captured) }
      )

      expect(
        (captured[0]?.init.headers as Record<string, string>).authorization
      ).toBe("Bearer apify-from-env")
    })

    it("throws when Apify rejects the token", async () => {
      // Not a helpful string: every retry would burn an LLM turn on a fault no
      // rephrasing can fix, and the run must fail rather than quietly produce
      // a brief built on nothing.
      await expect(
        search(
          SPEC,
          { query: "a" },
          { apiToken: "bad", fetch: fakeFetch(jsonResponse({}, 401), []) }
        )
      ).rejects.toThrow(/rejected the API token/)
    })
  })
})
