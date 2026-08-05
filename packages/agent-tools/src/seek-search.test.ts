import { afterEach, describe, expect, it } from "vitest"

import { apifySeekSearch } from "./seek-search.ts"

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

const API_TOKEN = "apify-test-token"

interface Capture {
  url: string
  init: RequestInit
}

function fakeFetch(reply: Response, captured: Capture[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    // Cloned, not returned directly: a Response body reads once, and some tests
    // drive the same fake through several calls.
    return reply.clone()
  }) as unknown as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function requestBody(capture: Capture): Record<string, unknown> {
  return JSON.parse(String(capture.init.body)) as Record<string, unknown>
}

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

afterEach(() => {
  delete process.env.APIFY_TOKEN
})

describe("apifySeekSearch", () => {
  it("sends the query to SEEK's actor and renders its fields", async () => {
    const captured: Capture[] = []

    const output = await apifySeekSearch(
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

    // The URL is the traceability requirement — a result the brief cannot link
    // to is not usable downstream. The listing date is the freshness evidence.
    expect(output).toContain("https://www.seek.com.au/job/79834521")
    expect(output).toContain("Software Engineer — Acme")
    expect(output).toContain("listed: 2026-07-28")
    expect(output).toContain("Sydney NSW · Full time · Hybrid · $120k – $140k")
    expect(output).toContain("Build TypeScript services")
    expect(output).toContain("• TypeScript")
  })

  it("never sends the actor's notification fields", async () => {
    const captured: Capture[] = []

    await apifySeekSearch(
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

    await apifySeekSearch({ query: "a" }, { apiToken: API_TOKEN, fetch })
    await apifySeekSearch(
      { query: "b", daysOld: 7 },
      { apiToken: API_TOKEN, fetch }
    )

    // Unlike Indeed's actor, SEEK's takes a freshness bound directly, so the
    // tool needs no post-fetch filter.
    expect(requestBody(captured[0]!).daysOld).toBe(30)
    expect(requestBody(captured[1]!).daysOld).toBe(7)
  })

  it("asks the actor for detail pages", async () => {
    const captured: Capture[] = []

    await apifySeekSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    // Without this the actor returns descriptionMarkdown as null, and the
    // scout sees a teaser and three bullets. Measured at 0.99x the scrape
    // time of a run without it — see the comment on the request body.
    expect(requestBody(captured[0]!).fetchDetails).toBe(true)
  })

  it("prefers the markdown description and falls back to the plain one", async () => {
    const both = [
      {
        ...ONE_JOB[0],
        descriptionMarkdown: "**What we would like from you**",
        descriptionText: "What we would like from you",
      },
    ]
    const textOnly = [
      {
        ...ONE_JOB[0],
        descriptionMarkdown: null,
        descriptionText: "We need someone who has shipped Postgres migrations.",
      },
    ]

    // Markdown first: the headings and bullets are what make a requirements
    // section findable, and the plain rendering flattens them.
    expect(
      await apifySeekSearch(
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(both), []) }
      )
    ).toContain("**What we would like from you**")

    // First non-empty rather than first non-null: the actor returns `null` for
    // a description it did not fetch and `""` for one that came back blank.
    expect(
      await apifySeekSearch(
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(textOnly), []) }
      )
    ).toContain("shipped Postgres migrations")
  })

  it("omits workType rather than sending null, and defaults the location", async () => {
    const captured: Capture[] = []

    await apifySeekSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    const body = requestBody(captured[0]!)
    expect(body).not.toHaveProperty("workType")
    expect(body.location).toBe("All Australia")
  })

  it("names SEEK when there is nothing to report", async () => {
    const output = await apifySeekSearch(
      { query: "zeppelin wrangler" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse([]), []) }
    )

    expect(output).toContain("No currently-listed SEEK postings")
    expect(output).toContain("zeppelin wrangler")
  })
})
