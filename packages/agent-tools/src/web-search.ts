import { tool } from "@langchain/core/tools"
import * as z from "zod"

import { clampMaxResults, requireEnv, searchApiPost } from "./internal/http.ts"

/**
 * Web search, via Tavily's REST API.
 *
 * Hand-rolled over `fetch` rather than wrapping `@langchain/tavily`, for the
 * same reason the agents are factories: that package's `TavilySearch` reads
 * `TAVILY_API_KEY` in its **constructor** and throws without one, so a
 * module-level `export const webSearch = new TavilySearch()` would move the
 * failure to import time and take every consumer that merely imports this
 * module down with it — including `ASSISTANT_TOOLS` in `@workspace/agents`,
 * which holds this exact singleton. Reading the key inside the call keeps
 * importing this module free, and keeps the package's dependencies to
 * `@langchain/core` and `zod`.
 */

const TAVILY_SEARCH_URL = "https://api.tavily.com/search"

/** Tavily's own default. Stated here so the request is explicit about it. */
const DEFAULT_MAX_RESULTS = 5

/** Tavily rejects anything above this. */
const MAX_RESULTS_LIMIT = 20

/**
 * The slice of Tavily's response this tool reads.
 *
 * `published_date` is deliberately optional: it comes back under
 * `topic: "news"` and is absent from a general search, so a result without one
 * is normal rather than malformed.
 */
interface TavilyResult {
  title?: string
  url?: string
  content?: string
  published_date?: string
}

interface TavilyResponse {
  results?: TavilyResult[]
}

export interface WebSearchInput {
  query: string
  maxResults?: number
  timeRange?: "day" | "week" | "month" | "year"
  includeDomains?: string[]
}

/** Injected in tests. Both default to the real thing. */
export interface WebSearchDeps {
  fetch?: typeof globalThis.fetch
  apiKey?: string
}

/**
 * A function, not a module constant, so importing this file never throws.
 * Mirrors `getOpenAIApiKey()` in `@workspace/agents-core`.
 */
function getTavilyApiKey(): string {
  return requireEnv("TAVILY_API_KEY", "search the web")
}

/**
 * One result per stanza, URL on its own line.
 *
 * The URL is the whole point of the traceability requirement — a brief that
 * cites a posting it cannot link to is not much of a brief — so it is given its
 * own line rather than buried in prose the model has to re-extract.
 */
function formatResults(query: string, results: TavilyResult[]): string {
  if (results.length === 0) {
    return `No results for "${query}". Try different or broader search terms.`
  }

  const stanzas = results.map((result, index) => {
    const lines = [
      `${index + 1}. ${result.title ?? "(untitled)"}`,
      `   ${result.url ?? "(no url)"}`,
    ]
    if (result.published_date)
      lines.push(`   published: ${result.published_date}`)
    if (result.content) lines.push(`   ${result.content}`)
    return lines.join("\n")
  })

  return [`${results.length} result(s) for "${query}":`, ...stanzas].join(
    "\n\n"
  )
}

/**
 * The tool's body, separated so a test can drive it with a fake `fetch` — a
 * tool's schema describes what the *model* passes, and has nowhere to carry a
 * dependency.
 *
 * Two classes of failure, handled differently on purpose. A missing or rejected
 * key is a deployment fault that no amount of rephrasing fixes, so it throws:
 * the registry turns that into an error tool result, and the run fails loudly
 * rather than producing a confident brief built on nothing. Everything else —
 * rate limits, upstream 5xx, a body that will not parse — comes back as a
 * helpful string, matching `get_current_time`'s posture, so one bad search does
 * not sink a run that has other searches to make.
 */
export async function tavilySearch(
  input: WebSearchInput,
  deps: WebSearchDeps = {}
): Promise<string> {
  const { query, maxResults, timeRange, includeDomains } = input
  const doFetch = deps.fetch ?? globalThis.fetch
  const apiKey = deps.apiKey ?? getTavilyApiKey()

  const requested = maxResults ?? DEFAULT_MAX_RESULTS
  const subject = `The search for "${query}"`

  const result = await searchApiPost({
    fetch: doFetch,
    url: TAVILY_SEARCH_URL,
    token: apiKey,
    body: {
      query,
      max_results: clampMaxResults(requested, MAX_RESULTS_LIMIT),
      search_depth: "basic",
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
    },
    subject,
    retryAdvice: "a different query",
    auth: {
      service: "Tavily",
      credential: "API key",
      envVar: "TAVILY_API_KEY",
    },
  })
  if (!result.ok) return result.message

  const body = result.body as TavilyResponse
  if (!Array.isArray(body.results)) {
    return `${subject} returned no result list. Continue with what you already have.`
  }

  return formatResults(query, body.results)
}

/**
 * Search the web for pages matching a query.
 *
 * Deliberately not named for job postings: it is a general search tool, and the
 * agent that carries it supplies the job-search intent through its prompt.
 */
export const webSearch = tool(
  async (input: WebSearchInput) => tavilySearch(input),
  {
    name: "web_search",
    description:
      "Search the web and get back page titles, URLs and snippets. Call this whenever you need current information from the internet — you cannot know what is posted online without it. Make several focused searches rather than one broad one.",
    schema: z.object({
      query: z
        .string()
        .describe(
          'What to search for, phrased as a search query rather than a question, e.g. "senior backend engineer Sydney remote".'
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS_LIMIT)
        .optional()
        .describe(
          `How many results to return, 1-${MAX_RESULTS_LIMIT}. Defaults to ${DEFAULT_MAX_RESULTS}.`
        ),
      timeRange: z
        .enum(["day", "week", "month", "year"])
        .optional()
        .describe(
          'Only return pages published within this window. Use "month" or narrower when recency matters, such as for job postings.'
        ),
      includeDomains: z
        .array(z.string())
        .optional()
        .describe(
          'Restrict the search to these domains, e.g. ["seek.com.au"]. Omit to search the whole web.'
        ),
    }),
  }
)
