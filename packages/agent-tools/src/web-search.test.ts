import { afterEach, describe, expect, it } from "vitest"

import {
  fakeFetch,
  jsonResponse,
  requestBody,
  type Capture,
} from "./test-support/search-fakes.ts"
import { tavilySearch } from "./web-search.ts"

/**
 * Everything worth testing lives in `tavilySearch` rather than in the tool
 * wrapper: a tool's schema describes what the *model* passes and has nowhere to
 * carry a fake `fetch`. The wrapper is a one-line call through.
 */

const API_KEY = "tvly-test-key"

const ONE_RESULT = {
  results: [
    {
      title: "Senior Backend Engineer",
      url: "https://example.com/jobs/1",
      content: "We are hiring a backend engineer.",
    },
  ],
}

afterEach(() => {
  delete process.env.TAVILY_API_KEY
})

describe("tavilySearch", () => {
  it("sends the query and returns url, title and snippet", async () => {
    const captured: Capture[] = []

    const output = await tavilySearch(
      { query: "backend engineer sydney" },
      { apiKey: API_KEY, fetch: fakeFetch(jsonResponse(ONE_RESULT), captured) }
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe("https://api.tavily.com/search")
    expect(requestBody(captured[0]!).query).toBe("backend engineer sydney")
    expect(
      (captured[0]?.init.headers as Record<string, string>).authorization
    ).toBe(`Bearer ${API_KEY}`)

    // The URL is the traceability requirement — a result the brief cannot link
    // to is not usable downstream.
    expect(output).toContain("https://example.com/jobs/1")
    expect(output).toContain("Senior Backend Engineer")
    expect(output).toContain("We are hiring a backend engineer.")
  })

  it("clamps maxResults into Tavily's accepted range", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_RESULT), captured)

    await tavilySearch(
      { query: "a", maxResults: 500 },
      { apiKey: API_KEY, fetch }
    )
    await tavilySearch(
      { query: "b", maxResults: 0 },
      { apiKey: API_KEY, fetch }
    )
    await tavilySearch({ query: "c" }, { apiKey: API_KEY, fetch })

    expect(requestBody(captured[0]!).max_results).toBe(20)
    expect(requestBody(captured[1]!).max_results).toBe(1)
    expect(requestBody(captured[2]!).max_results).toBe(5)
  })

  it("omits optional filters rather than sending nulls", async () => {
    const captured: Capture[] = []

    await tavilySearch(
      { query: "a" },
      { apiKey: API_KEY, fetch: fakeFetch(jsonResponse(ONE_RESULT), captured) }
    )

    const body = requestBody(captured[0]!)
    expect(body).not.toHaveProperty("time_range")
    expect(body).not.toHaveProperty("include_domains")
  })

  it("passes timeRange and includeDomains through when given", async () => {
    const captured: Capture[] = []

    await tavilySearch(
      { query: "a", timeRange: "month", includeDomains: ["seek.com.au"] },
      { apiKey: API_KEY, fetch: fakeFetch(jsonResponse(ONE_RESULT), captured) }
    )

    const body = requestBody(captured[0]!)
    expect(body.time_range).toBe("month")
    expect(body.include_domains).toEqual(["seek.com.au"])
  })

  it("includes published_date only when the result carries one", async () => {
    const withDate = {
      results: [
        { title: "T", url: "https://e.com/1", published_date: "2026-07-20" },
        { title: "U", url: "https://e.com/2" },
      ],
    }

    const output = await tavilySearch(
      { query: "a" },
      { apiKey: API_KEY, fetch: fakeFetch(jsonResponse(withDate), []) }
    )

    // A general search omits the field entirely — that is normal, not malformed.
    expect(output).toContain("published: 2026-07-20")
    expect(output.match(/published:/g)).toHaveLength(1)
  })

  it("reports an empty result set as a searchable outcome", async () => {
    const output = await tavilySearch(
      { query: "nothing at all" },
      { apiKey: API_KEY, fetch: fakeFetch(jsonResponse({ results: [] }), []) }
    )

    expect(output).toContain("No results")
    expect(output).toContain("nothing at all")
  })

  describe("failures the model can work around", () => {
    it("returns a message for a non-auth HTTP error", async () => {
      const output = await tavilySearch(
        { query: "a" },
        {
          apiKey: API_KEY,
          fetch: fakeFetch(jsonResponse({ error: "slow down" }, 429), []),
        }
      )

      expect(output).toContain("429")
      expect(output).toContain("continue with what you already have")
    })

    it("returns a message when the body will not parse", async () => {
      const notJson = new Response("<html>502</html>", { status: 200 })

      const output = await tavilySearch(
        { query: "a" },
        { apiKey: API_KEY, fetch: fakeFetch(notJson, []) }
      )

      expect(output).toContain("could not be read")
    })

    it("returns a message when the body carries no result list", async () => {
      const output = await tavilySearch(
        { query: "a" },
        { apiKey: API_KEY, fetch: fakeFetch(jsonResponse({ query: "a" }), []) }
      )

      expect(output).toContain("no result list")
    })

    it("returns a message when the request cannot be sent", async () => {
      const transportFault = new Error("getaddrinfo ENOTFOUND api.tavily.com")

      const output = await tavilySearch(
        { query: "a" },
        { apiKey: API_KEY, fetch: fakeFetch(transportFault, []) }
      )

      expect(output).toContain("could not be sent")
      expect(output).toContain("ENOTFOUND")
    })
  })

  describe("failures no rephrasing can fix", () => {
    it("throws when the API key is absent", async () => {
      // No apiKey injected and no env var: nothing to search with.
      await expect(
        tavilySearch({ query: "a" }, { fetch: fakeFetch(jsonResponse({}), []) })
      ).rejects.toThrow(/TAVILY_API_KEY is not set/)
    })

    it("reads the key from the environment when none is injected", async () => {
      process.env.TAVILY_API_KEY = "tvly-from-env"
      const captured: Capture[] = []

      await tavilySearch(
        { query: "a" },
        { fetch: fakeFetch(jsonResponse(ONE_RESULT), captured) }
      )

      expect(
        (captured[0]?.init.headers as Record<string, string>).authorization
      ).toBe("Bearer tvly-from-env")
    })

    it("throws when Tavily rejects the key", async () => {
      // Not a helpful string: every retry would burn an LLM turn on a fault no
      // rephrasing can fix, and the run must fail rather than quietly produce a
      // brief built on nothing.
      await expect(
        tavilySearch(
          { query: "a" },
          { apiKey: "bad", fetch: fakeFetch(jsonResponse({}, 401), []) }
        )
      ).rejects.toThrow(/rejected the API key/)
    })
  })
})
