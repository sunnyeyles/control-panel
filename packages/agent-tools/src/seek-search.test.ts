import { afterEach, describe, expect, it } from "vitest"

import { apifySeekSearch } from "./seek-search.ts"

/**
 * Everything worth testing lives in `apifySeekSearch` rather than in the tool
 * wrapper, exactly as `web-search.test.ts` does it: a tool's schema describes
 * what the *model* passes and has nowhere to carry a fake `fetch`.
 */

const API_TOKEN = "apify-test-token"

interface Capture {
  url: string
  init: RequestInit
}

/**
 * A `fetch` that records the request and replies from a script. An `Error`
 * reply is thrown rather than returned, standing in for a transport fault.
 */
function fakeFetch(reply: Response | Error, captured: Capture[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    if (reply instanceof Error) throw reply
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
  it("sends the query and returns url, title and listing date", async () => {
    const captured: Capture[] = []

    const output = await apifySeekSearch(
      { query: "software engineer TypeScript", location: "Sydney NSW" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toContain(
      "api.apify.com/v2/acts/unfenced-group~seek-com-au-scraper/run-sync-get-dataset-items"
    )
    expect(
      (captured[0]?.init.headers as Record<string, string>).authorization
    ).toBe(`Bearer ${API_TOKEN}`)

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
    expect(output).toContain("Build TypeScript services")
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

  it("defaults the freshness bound and lets the model tighten it", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_JOB), captured)

    await apifySeekSearch({ query: "a" }, { apiToken: API_TOKEN, fetch })
    await apifySeekSearch(
      { query: "b", daysOld: 7 },
      { apiToken: API_TOKEN, fetch }
    )

    expect(requestBody(captured[0]!).daysOld).toBe(30)
    expect(requestBody(captured[1]!).daysOld).toBe(7)
  })

  it("clamps maxResults into the tool's accepted range", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_JOB), captured)

    await apifySeekSearch(
      { query: "a", maxResults: 500 },
      { apiToken: API_TOKEN, fetch }
    )
    await apifySeekSearch(
      { query: "b", maxResults: 0 },
      { apiToken: API_TOKEN, fetch }
    )
    await apifySeekSearch({ query: "c" }, { apiToken: API_TOKEN, fetch })

    expect(requestBody(captured[0]!).maxItems).toBe(50)
    expect(requestBody(captured[1]!).maxItems).toBe(1)
    expect(requestBody(captured[2]!).maxItems).toBe(20)
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

  it("renders around missing fields rather than rejecting the item", async () => {
    const sparse = [{ url: "https://www.seek.com.au/job/1" }]

    const output = await apifySeekSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(sparse), []) }
    )

    // The actor is community-maintained; a missing title is a rendering
    // problem, not a malformed result.
    expect(output).toContain("(untitled)")
    expect(output).toContain("https://www.seek.com.au/job/1")
  })

  it("reports an empty result set as a searchable outcome", async () => {
    const output = await apifySeekSearch(
      { query: "zeppelin wrangler" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse([]), []) }
    )

    expect(output).toContain("No currently-listed SEEK postings")
    expect(output).toContain("zeppelin wrangler")
  })

  describe("failures the model can work around", () => {
    it("returns a message for a non-auth HTTP error", async () => {
      // Also the shape of a failed actor run: the synchronous endpoint
      // reports one as an error status, not a body to parse.
      const output = await apifySeekSearch(
        { query: "a" },
        {
          apiToken: API_TOKEN,
          fetch: fakeFetch(jsonResponse({ error: "run failed" }, 500), []),
        }
      )

      expect(output).toContain("500")
      expect(output).toContain("continue with what you already have")
    })

    it("returns a message when the body will not parse", async () => {
      const notJson = new Response("<html>502</html>", { status: 200 })

      const output = await apifySeekSearch(
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(notJson, []) }
      )

      expect(output).toContain("could not be read")
    })

    it("returns a message when the body is not an item array", async () => {
      const output = await apifySeekSearch(
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse({ data: 1 }), []) }
      )

      expect(output).toContain("no result list")
    })

    it("returns a message when the request cannot be sent", async () => {
      const transportFault = new Error("getaddrinfo ENOTFOUND api.apify.com")

      const output = await apifySeekSearch(
        { query: "a" },
        { apiToken: API_TOKEN, fetch: fakeFetch(transportFault, []) }
      )

      expect(output).toContain("could not be sent")
      expect(output).toContain("ENOTFOUND")
    })
  })

  describe("failures no rephrasing can fix", () => {
    it("throws when the token is absent", async () => {
      // No apiToken injected and no env var: nothing to search with.
      await expect(
        apifySeekSearch(
          { query: "a" },
          { fetch: fakeFetch(jsonResponse([]), []) }
        )
      ).rejects.toThrow(/APIFY_TOKEN is not set/)
    })

    it("reads the token from the environment when none is injected", async () => {
      process.env.APIFY_TOKEN = "apify-from-env"
      const captured: Capture[] = []

      await apifySeekSearch(
        { query: "a" },
        { fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
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
        apifySeekSearch(
          { query: "a" },
          { apiToken: "bad", fetch: fakeFetch(jsonResponse({}, 401), []) }
        )
      ).rejects.toThrow(/rejected the API token/)
    })
  })
})
