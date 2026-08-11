import { afterEach, describe, expect, it } from "vitest"

import { allTools } from "./index.ts"
import { extractPage, MAX_PAGE_CHARS } from "./page-extract.ts"
import {
  fakeFetch,
  jsonResponse,
  requestBody,
  type Capture,
} from "./test-support/search-fakes.ts"

const API_KEY = "tvly-test-key"
const URL = "https://boards.example.com/jobs/senior-backend-engineer"

const PAGE = {
  results: [
    {
      url: URL,
      raw_content: "# Senior Backend Engineer\n\nAcme, Sydney. We are hiring.",
    },
  ],
}

afterEach(() => {
  delete process.env.TAVILY_API_KEY
})

describe("extractPage", () => {
  it("asks Tavily for markdown at the URL it was given", async () => {
    const captured: Capture[] = []

    const result = await extractPage(URL, {
      apiKey: API_KEY,
      fetch: fakeFetch(jsonResponse(PAGE), captured),
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe("https://api.tavily.com/extract")
    expect(
      (captured[0]?.init.headers as Record<string, string>).authorization
    ).toBe(`Bearer ${API_KEY}`)

    const body = requestBody(captured[0]!)
    expect(body.urls).toEqual([URL])
    expect(body.format).toBe("markdown")

    expect(result).toEqual({
      status: "extracted",
      page: {
        url: URL,
        markdown: "# Senior Backend Engineer\n\nAcme, Sydney. We are hiring.",
      },
    })
  })

  it("carries back the caller's URL, not one out of the response", async () => {
    // Tavily echoes a URL of its own, and a redirect makes the two differ. The
    // stored Posting is keyed on what the user pasted, so this is the one that
    // has to survive.
    const redirected = {
      results: [{ url: "https://elsewhere.example.com/x", raw_content: "Job" }],
    }

    const result = await extractPage(URL, {
      apiKey: API_KEY,
      fetch: fakeFetch(jsonResponse(redirected), []),
    })

    expect(result).toMatchObject({ status: "extracted", page: { url: URL } })
  })

  it("bounds a page that is far too long, and says that it did", async () => {
    const long = {
      results: [{ raw_content: "x".repeat(MAX_PAGE_CHARS + 5_000) }],
    }

    const result = await extractPage(URL, {
      apiKey: API_KEY,
      fetch: fakeFetch(jsonResponse(long), []),
    })

    expect(result.status).toBe("extracted")
    const { markdown } = (result as { page: { markdown: string } }).page

    // A cut the reader cannot see is the failure mode: it would report a
    // posting it only half saw.
    expect(markdown).toContain("page truncated")
    expect(markdown.length).toBeLessThan(MAX_PAGE_CHARS + 200)
  })

  it("reports Tavily's own reason when it could not read the page", async () => {
    const refused = {
      results: [],
      failed_results: [{ url: URL, error: "sign-in required" }],
    }

    const result = await extractPage(URL, {
      apiKey: API_KEY,
      fetch: fakeFetch(jsonResponse(refused), []),
    })

    expect(result).toEqual({
      status: "failed",
      message: "That link could not be read: sign-in required",
    })
  })

  it("answers a person, not a model, when the request fails", async () => {
    const result = await extractPage(URL, {
      apiKey: API_KEY,
      fetch: fakeFetch(jsonResponse({}, 404), []),
    })

    expect(result.status).toBe("failed")
    const { message } = result as { message: string }

    expect(message).toContain("HTTP 404")
    expect(message).toContain("Check the link opens in a browser")
    // The default advice `searchApiPost` gives every search tool would be
    // nonsense to somebody who pasted a link into a form.
    expect(message).not.toContain("Continue with what you already have")
  })

  it("throws when the key is rejected, rather than blaming the link", async () => {
    await expect(
      extractPage(URL, {
        apiKey: API_KEY,
        fetch: fakeFetch(jsonResponse({}, 401), []),
      })
    ).rejects.toThrow("TAVILY_API_KEY")
  })

  it("throws when no key is set at all", async () => {
    await expect(
      extractPage(URL, { fetch: fakeFetch(jsonResponse(PAGE), []) })
    ).rejects.toThrow("TAVILY_API_KEY is not set")
  })
})

/**
 * The containment this module exists to keep.
 *
 * `extractPage` retrieves an arbitrary URL. `allTools` is what the general
 * assistant carries, so a `tool()` wrapper around this reaching that array
 * would hand a chat agent a fetcher — which is the thing `OVERVIEW.md` says
 * must not happen casually. This is a structural assertion, not a style one.
 */
describe("the fetcher is not a tool", () => {
  it("is absent from allTools", () => {
    expect(allTools.map((carried) => carried.name)).toEqual([
      "get_current_time",
      "web_search",
    ])
  })

  it("is a plain function with no tool interface on it", () => {
    expect(typeof extractPage).toBe("function")
    expect(extractPage).not.toHaveProperty("name", "page_extract")
    expect(extractPage).not.toHaveProperty("schema")
    expect(extractPage).not.toHaveProperty("invoke")
  })
})
