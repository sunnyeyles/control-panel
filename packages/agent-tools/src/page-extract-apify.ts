import {
  actorRunUrl,
  requireApifyToken,
  type ApifyHttpDeps,
} from "./apify-search.ts"
import { bound, type PageExtractResult } from "./page-extract.ts"
import { searchApiPost } from "./search-http.ts"

/**
 * Retrieve the page at a link via Apify's Website Content Crawler, as markdown.
 *
 * ⚠️ **This is deliberately not a tool**, for the same reason
 * `page-extract.ts` gives at greater length: a plain function, absent from
 * `allTools`, handed to no agent. It sits beside that module as a second
 * general fetcher for when Tavily cannot read the page — not as a board
 * scraper, and not as something an agent may call.
 *
 * **Retrieval is still delegated.** The request goes to Apify and Apify
 * fetches the page; this process never opens a socket to a host somebody typed
 * into a form. SSRF stays off the table the same way it does for Tavily.
 *
 * Used only as a fallback on the add-by-link general path. SEEK/Indeed board
 * failures do not chain here — see `add-by-link-actions.ts`.
 */

/** Apify actor id, tilde-separated for the sync run URL. */
const ACTOR_ID = "apify~website-content-crawler"

/**
 * Seconds the actor may spend, server-side.
 *
 * Shorter than the board-by-URL timeout (30s): this run only starts after
 * Tavily has already spent up to 15s, and a model call still has to fit inside
 * the route's `maxDuration` of 60.
 */
const RUN_TIMEOUT_SECONDS = 20

/** The slice of one Website Content Crawler dataset item this reads. */
interface CrawlerItem {
  markdown?: unknown
  text?: unknown
}

/**
 * `undefined` for a blank or non-string, so a field the actor returned as `""`
 * or as a number is treated as absent rather than stored.
 *
 * Same posture as `board-posting.ts`: a dataset item is JSON off a scraper, so
 * the declared shape is a description of what was observed, not a guarantee.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Fetch one page through Apify's Website Content Crawler.
 *
 * Two classes of failure, split as everywhere else in this package. A missing
 * or rejected `APIFY_TOKEN` is a deployment fault no retry fixes, so it
 * throws. Everything else comes back as a sentence addressed to a person.
 */
export async function extractPageViaApify(
  url: string,
  deps: ApifyHttpDeps = {}
): Promise<PageExtractResult> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const apiToken = deps.apiToken ?? requireApifyToken("read the page at a link")

  const result = await searchApiPost({
    fetch: doFetch,
    url: actorRunUrl(ACTOR_ID, RUN_TIMEOUT_SECONDS),
    token: apiToken,
    body: {
      startUrls: [{ url }],
      maxCrawlPages: 1,
      maxCrawlDepth: 0,
      saveMarkdown: true,
      crawlerType: "playwright:adaptive",
      proxyConfiguration: { useApifyProxy: true },
    },
    subject: "That link",
    fallbackAdvice: "Check the link opens in a browser, and try again.",
    auth: {
      service: "Apify",
      credential: "API token",
      envVar: "APIFY_TOKEN",
    },
  })

  if (!result.ok) return { status: "failed", message: result.message }

  if (!Array.isArray(result.body) || result.body.length === 0) {
    return {
      status: "failed",
      message:
        "That link returned no readable page. It may need a sign-in, or be one the site serves only to a browser.",
    }
  }

  const item = result.body[0] as CrawlerItem
  const content = text(item.markdown) ?? text(item.text)

  if (!content) {
    return {
      status: "failed",
      message:
        "That link returned no readable page. It may need a sign-in, or be one the site serves only to a browser.",
    }
  }

  return { status: "extracted", page: { url, markdown: bound(content) } }
}
