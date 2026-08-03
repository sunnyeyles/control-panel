import { tool } from "@langchain/core/tools"
import * as z from "zod"

import {
  clampResultCount,
  requireApiCredential,
  runSearchRequest,
} from "./search-request.ts"

/**
 * Web search, via Tavily's REST API.
 *
 * Hand-rolled over `fetch` rather than wrapping `@langchain/tavily`, for the
 * same reason the agents are factories: that package's `TavilySearch` reads
 * `TAVILY_API_KEY` in its **constructor** and throws without one, so a
 * module-level `export const webSearch = new TavilySearch()` would move the
 * failure to import time and take `allTools` — and every consumer that merely
 * imports the catalog — down with it. Reading the key inside the call keeps
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
 * Named here, read inside the call. `requireApiCredential` is what makes
 * importing this file free — the same rule `getOpenAIApiKey()` follows in
 * `@workspace/agents-core`.
 */
const CREDENTIAL = {
  service: "Tavily",
  noun: "API key",
  variable: "TAVILY_API_KEY",
} as const

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
 * The request envelope and its two-class failure posture live in
 * `search-request.ts`, shared with `seek-search.ts` rather than copied into it:
 * a missing or rejected key throws, and everything a model could work around
 * comes back as a sentence. What stays here is what is actually Tavily's — the
 * URL, the body's field names, and where the result list sits in the response.
 */
export async function tavilySearch(
  input: WebSearchInput,
  deps: WebSearchDeps = {}
): Promise<string> {
  const { query, maxResults, timeRange, includeDomains } = input

  const outcome = await runSearchRequest<TavilyResult>({
    url: TAVILY_SEARCH_URL,
    token:
      deps.apiKey ??
      requireApiCredential(CREDENTIAL.variable, "search the web"),
    body: {
      query,
      max_results: clampResultCount(
        maxResults ?? DEFAULT_MAX_RESULTS,
        MAX_RESULTS_LIMIT
      ),
      search_depth: "basic",
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
    },
    credential: CREDENTIAL,
    subject: `The search for "${query}"`,
    retryWith: "a different query",
    results: (body) => {
      const results = (body as TavilyResponse | null)?.results
      return Array.isArray(results) ? results : undefined
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })

  if (!outcome.ok) return outcome.message

  return formatResults(query, outcome.results)
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
