import {
  actorRunUrl,
  condense,
  requireApifyToken,
  type ApifyBoardSpec,
} from "./apify-search.ts"
import { searchApiPost } from "../internal/http.ts"

/**
 * Retrieve one advertisement from the board that serves it, by its own URL.
 *
 * ⚠️ **This is deliberately not a tool**, for the reason `page-extract.ts`
 * gives at greater length: a plain function, handed to no agent. It sits under
 * `boards/`, where a tool is ordinary, so R9's directory rule cannot carry the
 * case — the assertion in `by-url.test.ts` is the whole guard.
 *
 * **What it buys over the general fetcher is the absence of a model.** An actor
 * returns `title`, `company`, `location` and `descriptionMarkdown` as the board
 * published them, so the Posting arrives with no extraction step to get it
 * wrong. It also side-steps the bot walls SEEK and Indeed serve a general
 * fetcher.
 *
 * The trade is coverage: only a board with a {@link ApifyBoardSpec.byUrl} can
 * answer — SEEK and Indeed, not LinkedIn, whose actor takes search URLs only.
 * Everything else falls past to the general fetcher.
 *
 * **Retrieval is delegated here too**, so this process still never opens a
 * socket to a host somebody typed into a form.
 */

/**
 * Seconds an advertisement run may take, server-side.
 *
 * ⚠️ **A quarter of `RUN_TIMEOUT_SECONDS`, and the difference is the caller.** A
 * board search runs on a schedule inside a Lambda, where two minutes is
 * affordable; this runs on a request a person is waiting on, inside a route
 * whose `maxDuration` is 60. One advertisement is also a far smaller job than a
 * forty-result search — what dominates it is the actor's container start, which
 * `seek-search.ts` measured at most of a ten-second run.
 */
const URL_RUN_TIMEOUT_SECONDS = 30

/**
 * How much of an advertisement becomes the Posting's `summary`, in characters.
 *
 * Sized to the field's own contract — "two or three sentences on what the role
 * involves" — rather than to `MAX_TEASER_CHARS`, which is sized to two lines of
 * a search result. Where the board publishes a teaser this is rarely reached.
 */
const MAX_SUMMARY_CHARS = 600

/** What the board says about one advertisement, with the mandatory fields filled. */
export interface FetchedAdvertisement {
  /** How prose spells the board it came from, e.g. `SEEK`. */
  board: string
  title: string
  company: string
  location: string
  summary: string
  postedAt?: string
  highlights?: string[]
}

/**
 * Fetched, not this board's to fetch, or a sentence saying why not.
 *
 * `unsupported` is separated from `failed` because the two mean opposite things
 * to a caller: one says "ask somebody else", and the other says "the board that
 * owns this advertisement was asked, and could not". Collapsing them would make
 * a LinkedIn link and a broken SEEK run the same event.
 */
export type BoardPostingResult =
  | { status: "fetched"; posting: FetchedAdvertisement }
  | { status: "unsupported" }
  | { status: "failed"; message: string }

export interface BoardPostingDeps {
  fetch?: typeof globalThis.fetch
  apiToken?: string
  /**
   * The platform's posting identity, as a function of the URL.
   *
   * ⚠️ **Injected for the reason `PostingCatalog.idFor` is**: `postingId()` in
   * `@workspace/agents` is the one answer to this question and this package must
   * not depend on that one. A second hash living down here would be a second
   * identity for the same advertisement.
   */
  idFor(url: string): string
}

/**
 * What a board says when it says nothing useful.
 *
 * One sentence for several causes, addressed to the person holding the link
 * rather than to a model — the same posture `page-extract.ts` takes, and the
 * reason both pass their own `fallbackAdvice` to {@link searchApiPost}.
 */
const NOTHING_BACK =
  "The board returned nothing for that link. It may have been taken down, or be one the board no longer serves."

/**
 * `undefined` for a blank, so a field the actor returned as `""` is treated as
 * absent rather than stored as an empty string.
 *
 * ⚠️ **The `typeof` check is not redundant with the types.** A dataset item is
 * JSON off a community-maintained scraper, so its declared shape is a
 * description of what was observed rather than a guarantee; a field that turns
 * up as a number or an object would make `.trim()` throw, and a throw here is
 * reported as "something went wrong" where a missing field is reported as
 * missing.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Fetch the advertisement at `url` from `spec`'s board.
 *
 * Two failures throw rather than answering, both inherited from
 * {@link searchApiPost}: a missing `APIFY_TOKEN`, and one the service rejects.
 * Each is a deployment fault no retry fixes, and reporting it as a broken link
 * would send somebody off to check a URL that is fine.
 */
export async function fetchBoardPosting<TItem>(
  spec: ApifyBoardSpec<TItem>,
  url: string,
  deps: BoardPostingDeps
): Promise<BoardPostingResult> {
  const { byUrl } = spec
  if (!byUrl) return { status: "unsupported" }

  const doFetch = deps.fetch ?? globalThis.fetch
  const apiToken =
    deps.apiToken ??
    requireApifyToken(`read the ${spec.board} posting at a link`)

  const result = await searchApiPost({
    fetch: doFetch,
    url: actorRunUrl(spec.actorId, URL_RUN_TIMEOUT_SECONDS),
    token: apiToken,
    body: byUrl.buildRequestBody(url),
    subject: `That ${spec.board} link`,
    fallbackAdvice: "Try again in a moment.",
    auth: { service: "Apify", credential: "API token", envVar: "APIFY_TOKEN" },
  })
  if (!result.ok) return { status: "failed", message: result.message }

  // The synchronous endpoint returns the dataset items as a bare array. An
  // empty one is a different event from a full one that holds the wrong
  // posting, and they are worth different sentences: a board that returned
  // nothing has most likely lost the advertisement, and a board that returned
  // other people's postings was handed a link to a search.
  if (!Array.isArray(result.body) || result.body.length === 0) {
    return { status: "failed", message: NOTHING_BACK }
  }

  const wanted = deps.idFor(url)

  // ⚠️ **The item has to be the advertisement that was asked for.** Indeed's
  // `startUrls` accepts a search or a company page as readily as a job, and
  // would answer either with a list of *other* postings; SEEK's would answer a
  // browse URL the same way. Matching on the platform's own identity rather than
  // on string equality is what makes this check right despite tracking
  // parameters — the pasted link and the board's canonical one normalise to the
  // same id, and an unrelated posting does not. Taking `[0]` on trust is how a
  // paste of a search page becomes one arbitrary role stored as though somebody
  // had chosen it.
  const found = (result.body as TItem[])
    .map((item) => byUrl.toAdvertisement(item))
    .find((ad) => {
      const adUrl = text(ad.url)
      return adUrl !== undefined && deps.idFor(adUrl) === wanted
    })

  if (!found) {
    return {
      status: "failed",
      message: `That ${spec.board} link did not resolve to a single job advertisement. Paste the link to one posting rather than to a search or a company page.`,
    }
  }

  const title = text(found.title)
  const summary = condense(
    text(found.teaser),
    text(found.description),
    MAX_SUMMARY_CHARS
  )

  // A result with no title is not an advertisement this can store, and there is
  // nothing to substitute: `title` is what the table renders and what every
  // message about the Posting names it by. `company` and `location` do have a
  // substitute, and it is the one the extractor's schema already prescribes for
  // a page that does not say — "Unknown" is a true statement about what the
  // board published, where a guess would not be.
  if (!title || !summary) {
    return { status: "failed", message: NOTHING_BACK }
  }

  const postedAt = text(found.postedAt)
  // Copied word for word by the advertiser, or absent. Never an empty array —
  // the field is optional, and an empty one would render as a heading over
  // nothing. Non-strings are dropped for the reason {@link text} gives.
  const highlights = (
    Array.isArray(found.highlights) ? found.highlights : []
  ).flatMap((line) => {
    const kept = text(line)
    return kept ? [kept] : []
  })

  return {
    status: "fetched",
    posting: {
      board: spec.board,
      title,
      company: text(found.company) ?? "Unknown",
      location: text(found.location) ?? "Unknown",
      summary,
      ...(postedAt ? { postedAt } : {}),
      ...(highlights.length > 0 ? { highlights } : {}),
    },
  }
}
