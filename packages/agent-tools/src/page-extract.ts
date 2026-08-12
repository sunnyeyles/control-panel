import { requireEnv, searchApiPost } from "./search-http.ts"

/**
 * Retrieve the page at a link, as markdown.
 *
 * ⚠️ **This is deliberately not a tool, and that is the whole design.** A plain
 * function, absent from `allTools`, handed to no `createX()` factory —
 * `page-extract.test.ts` asserts both. Wrapping it in `tool()` would put an
 * arbitrary URL fetcher in the hands of whichever agent picked it up, including
 * the general assistant, which carries `allTools`. Do not. A caller retrieves
 * the page and hands the text to an agent that can do nothing but answer.
 *
 * **Retrieval is delegated, and that is a security property.** Tavily fetches
 * the page; this process never opens a socket to a host somebody typed into a
 * form, so there is no SSRF surface, no redirect chain to bound, no streaming
 * response to cut off. What is left is the size of the reply, which
 * {@link MAX_PAGE_CHARS} bounds, and the untrusted text itself, which the
 * reading agent's empty tool set contains.
 */

const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"

/**
 * Seconds Tavily may spend fetching before it gives up.
 *
 * Its own default for `extract_depth: "basic"` is 10. This asks for a little
 * more because a slow advertisement is still worth having, and stays well inside
 * the route's `maxDuration` with a model call still to make afterwards.
 */
const FETCH_TIMEOUT_SECONDS = 15

/**
 * How much of a page to carry, in characters.
 *
 * A job advertisement is a few thousand characters of substance wrapped in a
 * page that may be very much larger — navigation, related roles, footers,
 * cookie notices. This bounds what reaches a model rather than what Tavily
 * returns, exactly as `MAX_DESCRIPTION_CHARS` does in `posting-details.ts`, and
 * it is generous on purpose: the advertisement is somewhere in there, and where
 * it sits in the document is not something a caller can know in advance.
 */
export const MAX_PAGE_CHARS = 40_000

/** The slice of Tavily's `/extract` response this reads. */
interface TavilyExtractResult {
  url?: string
  raw_content?: string
}

interface TavilyExtractFailure {
  url?: string
  error?: string
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[]
  failed_results?: TavilyExtractFailure[]
}

export interface ExtractedPage {
  /** The URL that was asked for — the caller's, never one off the page. */
  url: string
  /** The page as markdown, bounded by {@link MAX_PAGE_CHARS}. */
  markdown: string
}

/**
 * Retrieved, or a sentence saying why not.
 *
 * A failure here is an ordinary answer rather than an exception: a link can be
 * dead, private, behind a login wall or simply slow, and every one of those is
 * something to tell the person who pasted it rather than something to log.
 */
export type PageExtractResult =
  | { status: "extracted"; page: ExtractedPage }
  | { status: "failed"; message: string }

/** Injected in tests. Both default to the real thing. */
export interface PageExtractDeps {
  fetch?: typeof globalThis.fetch
  apiKey?: string
}

/**
 * A function, not a module constant, so importing this file never throws.
 * Mirrors `getTavilyApiKey()` in `web-search.ts`.
 */
function getTavilyApiKey(): string {
  return requireEnv("TAVILY_API_KEY", "read the page at a link")
}

/**
 * Bounded, and it says so when it is bounded.
 *
 * Trimming from the end is not as safe here as it is for a description — a page
 * may put its advertisement anywhere — so the marker matters more, not less: an
 * agent that reads a cut as the end of the document would report a posting it
 * only half saw.
 *
 * Exported so the Apify fallback in `page-extract-apify.ts` applies the same
 * bound and the same marker — two fetchers, one result shape.
 */
export function bound(content: string): string {
  const trimmed = content.trim()

  return trimmed.length > MAX_PAGE_CHARS
    ? `${trimmed.slice(0, MAX_PAGE_CHARS).trimEnd()}\n[…] (page truncated at ${MAX_PAGE_CHARS} characters; it continues)`
    : trimmed
}

/**
 * Fetch one page.
 *
 * Two classes of failure, split as everywhere else in this package. A missing or
 * rejected key is a deployment fault no retry fixes, so it throws — the caller
 * turns that into "something went wrong" and logs it, rather than telling
 * somebody their perfectly good link is broken. Everything else comes back as a
 * sentence addressed to a person, which is why this passes its own
 * `fallbackAdvice` to {@link searchApiPost} instead of the model-facing default.
 */
export async function extractPage(
  url: string,
  deps: PageExtractDeps = {}
): Promise<PageExtractResult> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const apiKey = deps.apiKey ?? getTavilyApiKey()

  const result = await searchApiPost({
    fetch: doFetch,
    url: TAVILY_EXTRACT_URL,
    token: apiKey,
    body: {
      urls: [url],
      format: "markdown",
      extract_depth: "basic",
      timeout: FETCH_TIMEOUT_SECONDS,
    },
    subject: "That link",
    fallbackAdvice: "Check the link opens in a browser, and try again.",
    auth: {
      service: "Tavily",
      credential: "API key",
      envVar: "TAVILY_API_KEY",
    },
  })

  if (!result.ok) return { status: "failed", message: result.message }

  const body = result.body as TavilyExtractResponse
  const content = body.results?.[0]?.raw_content?.trim()

  if (!content) {
    // Tavily reports a page it could not read here rather than as an error
    // status, and its sentence is the useful half — a login wall and a 404 are
    // the same shape at this layer and are not the same thing to a reader.
    const reason = body.failed_results?.[0]?.error?.trim()

    return {
      status: "failed",
      message: reason
        ? `That link could not be read: ${reason}`
        : "That link returned no readable page. It may need a sign-in, or be one the site serves only to a browser.",
    }
  }

  return { status: "extracted", page: { url, markdown: bound(content) } }
}
