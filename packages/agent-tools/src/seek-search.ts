import { tool } from "@langchain/core/tools"
import * as z from "zod"

/**
 * SEEK job search, via Apify's `unfenced-group/seek-com-au-scraper` actor.
 *
 * The scout used to find postings with general web search, and the URLs in its
 * briefs were mostly dead on arrival: a search engine's index carries a job
 * board's *browse* pages rather than its postings, and the few posting URLs it
 * does surface are often closed by the time anyone clicks. Querying the
 * board's live inventory removes both failure modes at the source — every
 * result is an individual posting at its canonical `seek.com.au/job/{id}`
 * URL, and it was listed at the moment the search returned it.
 *
 * Plain `fetch` against Apify's synchronous run endpoint, not an MCP client:
 * the worker runs in a Lambda with a bounded timeout, and the data source
 * speaks REST. The token is read inside the call, exactly as `web-search.ts`
 * reads its key, so importing this module never throws and the package's
 * dependencies stay at `@langchain/core` and `zod`.
 *
 * Two caveats, stated rather than hidden. The actor is a community scraper,
 * not a SEEK product, and SEEK's terms prohibit automated collection — using
 * it was an explicit product decision, not a technical default. And the actor
 * itself accepts webhook, Telegram and Slack notification fields that this
 * tool never sends: the input schema below is the scout's entire reach, which
 * is what keeps "a scraper returns data and performs no side effects"
 * structural rather than a prompt line.
 */

const APIFY_RUN_SYNC_URL =
  "https://api.apify.com/v2/acts/unfenced-group~seek-com-au-scraper/run-sync-get-dataset-items"

/** Enough for one focused search without flooding the model's context. */
const DEFAULT_MAX_RESULTS = 20

/** A scout pass ranks a handful of matches; it has no use for hundreds. */
const MAX_RESULTS_LIMIT = 50

/**
 * The default freshness bound, in days. The point of querying live inventory
 * is that nothing stale comes back; this keeps even a quiet criterion from
 * dredging up postings a month past their interview rounds.
 */
const DEFAULT_DAYS_OLD = 30

/**
 * Caps the actor run server-side, in seconds. A wedged scrape then fails this
 * one search rather than sitting on the Lambda's whole budget.
 */
const RUN_TIMEOUT_SECONDS = 120

/**
 * The slice of an actor result this tool reads. Everything is optional on
 * purpose: the actor is community-maintained, so a missing field is rendered
 * around rather than treated as malformed.
 */
interface SeekJob {
  title?: string
  company?: string
  location?: string
  url?: string
  publishDateISO?: string
  workType?: string
  workArrangement?: string
  salaryLabel?: string
  teaser?: string
  bulletPoints?: string[]
}

export interface SeekSearchInput {
  query: string
  location?: string
  maxResults?: number
  daysOld?: number
  workType?: "Full time" | "Part time" | "Contract/Temp" | "Casual/Vacation"
}

/** Injected in tests. Both default to the real thing. */
export interface SeekSearchDeps {
  fetch?: typeof globalThis.fetch
  apiToken?: string
}

/**
 * A function, not a module constant, so importing this file never throws.
 * Mirrors `getTavilyApiKey()` in `web-search.ts`.
 */
function getApifyToken(): string {
  const apiToken = process.env.APIFY_TOKEN
  if (!apiToken) {
    throw new Error(
      "APIFY_TOKEN is not set, so there is no way to search SEEK."
    )
  }
  return apiToken
}

/**
 * One posting per stanza, URL on its own line.
 *
 * Same arrangement as `web-search.ts`, for the same reason: the URL is the
 * whole point of the traceability requirement, so it gets its own line rather
 * than being buried in prose the model has to re-extract. The listing date
 * rides along because it is the evidence of freshness a brief should carry.
 */
function formatResults(query: string, jobs: SeekJob[]): string {
  if (jobs.length === 0) {
    return `No currently-listed SEEK postings for "${query}". Try a broader title, another location, or a larger daysOld.`
  }

  const stanzas = jobs.map((job, index) => {
    const facts = [
      job.location,
      job.workType,
      job.workArrangement,
      job.salaryLabel,
    ].filter(Boolean)

    const lines = [
      `${index + 1}. ${job.title ?? "(untitled)"} — ${job.company ?? "(company unknown)"}`,
      `   ${job.url ?? "(no url)"}`,
    ]
    if (job.publishDateISO) lines.push(`   listed: ${job.publishDateISO}`)
    if (facts.length > 0) lines.push(`   ${facts.join(" · ")}`)
    if (job.teaser) lines.push(`   ${job.teaser}`)
    if (job.bulletPoints?.length)
      lines.push(`   • ${job.bulletPoints.join("\n   • ")}`)
    return lines.join("\n")
  })

  return [
    `${jobs.length} currently-listed posting(s) for "${query}":`,
    ...stanzas,
  ].join("\n\n")
}

/**
 * The tool's body, separated so a test can drive it with a fake `fetch` — a
 * tool's schema describes what the *model* passes, and has nowhere to carry a
 * dependency.
 *
 * Failure posture copied from `tavilySearch`, including the split: a missing
 * or rejected token is a deployment fault no rephrasing fixes, so it throws
 * and the run fails loudly. Everything else — a failed actor run (the
 * synchronous endpoint reports one as an error status), rate limits, a body
 * that will not parse — comes back as a helpful string, so one bad search
 * does not sink a run that has other searches to make.
 */
export async function apifySeekSearch(
  input: SeekSearchInput,
  deps: SeekSearchDeps = {}
): Promise<string> {
  const { query, location, maxResults, daysOld, workType } = input
  const doFetch = deps.fetch ?? globalThis.fetch
  const apiToken = deps.apiToken ?? getApifyToken()

  const requested = maxResults ?? DEFAULT_MAX_RESULTS
  const clamped = Math.min(
    Math.max(Math.trunc(requested), 1),
    MAX_RESULTS_LIMIT
  )

  let response: Response
  try {
    response = await doFetch(
      `${APIFY_RUN_SYNC_URL}?timeout=${RUN_TIMEOUT_SECONDS}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        // `fetchDetails` stays off: the teaser and bullet points carry enough
        // for a two-sentence summary, and detail pages triple the scrape time.
        body: JSON.stringify({
          searchQuery: query,
          location: location ?? "All Australia",
          country: "AU",
          maxItems: clamped,
          daysOld: daysOld ?? DEFAULT_DAYS_OLD,
          sortMode: "ListedDate",
          ...(workType ? { workType } : {}),
        }),
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `The SEEK search for "${query}" could not be sent: ${message}. Continue with what you already have.`
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Apify rejected the API token (HTTP ${response.status}). APIFY_TOKEN is set but not accepted.`
    )
  }

  if (!response.ok) {
    return `The SEEK search for "${query}" failed with HTTP ${response.status}. Try again with different criteria, or continue with what you already have.`
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return `The SEEK search for "${query}" returned a response that could not be read. Continue with what you already have.`
  }

  // The synchronous endpoint returns the dataset items as a bare array.
  if (!Array.isArray(body)) {
    return `The SEEK search for "${query}" returned no result list. Continue with what you already have.`
  }

  return formatResults(query, body as SeekJob[])
}

/**
 * Search SEEK's live listings.
 *
 * Named for the board, unlike `web_search`: which inventory answers the
 * question is exactly what the scout needs to know, and what the worker's
 * search gate counts.
 */
export const seekSearch = tool(
  async (input: SeekSearchInput) => apifySeekSearch(input),
  {
    name: "seek_search",
    description:
      "Search seek.com.au's live listings for currently-open job postings. Every result is an individual posting with its canonical URL and listing date. Make one focused search per role title and location, and report URLs verbatim — never edit or shorten them.",
    schema: z.object({
      query: z
        .string()
        .describe(
          'Role title or keywords, e.g. "software engineer TypeScript".'
        ),
      location: z
        .string()
        .optional()
        .describe(
          'Where, as SEEK writes it — "Sydney NSW", "Melbourne VIC", "All Australia". Defaults to all of Australia.'
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS_LIMIT)
        .optional()
        .describe(
          `How many postings to return, 1-${MAX_RESULTS_LIMIT}. Defaults to ${DEFAULT_MAX_RESULTS}.`
        ),
      daysOld: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `Only postings listed within this many days. Defaults to ${DEFAULT_DAYS_OLD}; tighten it when recency matters more than volume.`
        ),
      workType: z
        .enum(["Full time", "Part time", "Contract/Temp", "Casual/Vacation"])
        .optional()
        .describe("Restrict to one employment type. Omit for all."),
    }),
  }
)
