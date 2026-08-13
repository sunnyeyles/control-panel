import { beforeEach, describe, expect, it } from "vitest"

import type { PostingCatalog } from "./posting-catalog.ts"
import {
  apifySeekSearch,
  SEEK_SPEC,
  type SeekSearchDeps,
} from "./seek-search.ts"
import {
  API_TOKEN,
  fakeFetch,
  jsonResponse,
  requestBody,
  sequentialCatalog,
  type Capture,
} from "../test-support/search-fakes.ts"

/**
 * What is true of SEEK and of no other board: the actor it runs, the request
 * body that actor wants, and which of its fields carry the title, the URL and
 * the description. The token handling, the clamp, the failure split, the
 * truncation and the rendering are shared, and `apify-search.test.ts` owns
 * them.
 *
 * Driven through `apifySeekSearch` rather than the tool wrapper, exactly as
 * `web-search.test.ts` does it: a tool's schema describes what the *model*
 * passes and has nowhere to carry a fake `fetch`.
 */

/** One item, shaped as the actor's dataset returns it: a bare array. */
const ONE_JOB = [
  {
    title: "Software Engineer",
    company: "Acme",
    location: "Sydney NSW",
    url: "https://www.seek.com.au/job/79834521",
    publishDateISO: "2026-07-28",
    workType: "Full time",
    workArrangement: "Hybrid",
    salaryLabel: "$120k – $140k",
    teaser: "Build TypeScript services in a small product team.",
    bulletPoints: ["TypeScript", "Postgres"],
  },
]

let catalog: PostingCatalog

beforeEach(() => {
  catalog = sequentialCatalog()
})

/** `apifySeekSearch` against the catalog this test is holding. */
function seekSearch(
  input: Parameters<typeof apifySeekSearch>[0],
  deps: SeekSearchDeps
): Promise<string> {
  return apifySeekSearch(input, catalog, deps)
}

describe("apifySeekSearch", () => {
  it("sends the query to SEEK's actor and renders its fields", async () => {
    const captured: Capture[] = []

    const output = await seekSearch(
      { query: "software engineer TypeScript", location: "Sydney NSW" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toContain(
      "api.apify.com/v2/acts/unfenced-group~seek-com-au-scraper/run-sync-get-dataset-items"
    )

    const body = requestBody(captured[0]!)
    expect(body.searchQuery).toBe("software engineer TypeScript")
    expect(body.location).toBe("Sydney NSW")
    expect(body.country).toBe("AU")
    expect(body.sortMode).toBe("ListedDate")

    expect(output).toContain("[id1] Software Engineer — Acme")
    expect(output).toContain("listed: 2026-07-28")
    expect(output).toContain("Sydney NSW · Full time · Hybrid · $120k – $140k")
    expect(output).toContain("Build TypeScript services")

    // The URL is the traceability requirement — a result the brief cannot link
    // to is not usable downstream — and it is kept in the catalog rather than
    // put in front of the model. The bullets go the same way: they are what a
    // `highlights` line is copied from, and copying happens after shortlisting.
    expect(output).not.toContain("https://www.seek.com.au/job/79834521")
    expect(output).not.toContain("• TypeScript")
    expect(catalog.get("id1")).toMatchObject({
      board: "SEEK",
      url: "https://www.seek.com.au/job/79834521",
      bullets: ["TypeScript", "Postgres"],
    })
  })

  it("never sends the actor's notification fields", async () => {
    const captured: Capture[] = []

    await seekSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    // The actor can post results to webhooks, Telegram and Slack. The scout
    // must have no way to write, so the request body must never grow one of
    // these keys — this is the structural no-side-effects property, asserted.
    const body = requestBody(captured[0]!)
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/webhook|telegram|slack|whatsapp|notification/i)
    }
  })

  it("passes the freshness bound to the actor, which enforces it", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_JOB), captured)

    await seekSearch({ query: "a" }, { apiToken: API_TOKEN, fetch })
    await seekSearch({ query: "b", daysOld: 7 }, { apiToken: API_TOKEN, fetch })

    // Unlike Indeed's actor, SEEK's takes a freshness bound directly, so the
    // tool needs no post-fetch filter.
    expect(requestBody(captured[0]!).daysOld).toBe(30)
    expect(requestBody(captured[1]!).daysOld).toBe(7)
  })

  it("asks the actor for detail pages", async () => {
    const captured: Capture[] = []

    await seekSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    // Without this the actor returns descriptionMarkdown as null, and the
    // scout sees a teaser and three bullets. Measured at 0.99x the scrape
    // time of a run without it — see the comment on the request body.
    expect(requestBody(captured[0]!).fetchDetails).toBe(true)
  })

  /**
   * Asserted on the catalog rather than on the output, because that is where a
   * description goes now — `get_posting_details` reads it back from here, and a
   * search shows a teaser drawn from it.
   *
   * One search per case: the catalog keeps the first entry it is given for an
   * id, so running both against one catalog would only ever read the first.
   */
  describe("the description it stores", () => {
    async function describedBy(
      job: Record<string, unknown>
    ): Promise<string | null | undefined> {
      await seekSearch(
        { query: "a" },
        {
          apiToken: API_TOKEN,
          fetch: fakeFetch(jsonResponse([{ ...ONE_JOB[0], ...job }]), []),
        }
      )
      return catalog.get("id1")?.description
    }

    it("prefers the markdown rendering", async () => {
      // The headings and bullets are what make a requirements section findable,
      // and the plain rendering flattens them.
      expect(
        await describedBy({
          descriptionMarkdown: "**What we would like from you**",
          descriptionText: "What we would like from you",
        })
      ).toBe("**What we would like from you**")
    })

    it("falls back to the plain one, on empty rather than on null", async () => {
      // The actor returns `null` for a description it did not fetch and `""`
      // for one that came back blank, so falling through both is what makes the
      // plain rendering a real fallback.
      expect(
        await describedBy({
          descriptionMarkdown: "",
          descriptionText:
            "We need someone who has shipped Postgres migrations.",
        })
      ).toContain("shipped Postgres migrations")
    })
  })

  it("omits workType rather than sending null, and defaults the location", async () => {
    const captured: Capture[] = []

    await seekSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    const body = requestBody(captured[0]!)
    expect(body).not.toHaveProperty("workType")
    expect(body.location).toBe("All Australia")
  })

  it("declares the board name the empty-result sentence renders", () => {
    // The sentence itself — "No currently-listed <board> postings", echoing
    // the query — is `formatSearchResults`'s, owned by `apify-search.test.ts`.
    // What is SEEK's alone is the spelling.
    expect(SEEK_SPEC.board).toBe("SEEK")
  })
})
