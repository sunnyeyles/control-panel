import {
  fetchBoardPosting,
  type BoardPostingDeps,
} from "@workspace/agent-tools/board-posting"
import { INDEED_SPEC } from "@workspace/agent-tools/indeed-search"
import { SEEK_SPEC } from "@workspace/agent-tools/seek-search"
import * as z from "zod"

import { boardForHost } from "./job-boards.ts"
import { postingId } from "./posting-id.ts"
import { StoredPostingSchema, type StoredPosting } from "./stored-posting.ts"

/**
 * Ask the board that serves a link for the advertisement behind it.
 *
 * **This layer exists because neither of the two below it may reach the other.**
 * `@workspace/agent-tools` holds the actors and must not depend on this package
 * — `posting-catalog.ts` states that rule and takes `idFor` as an injection for
 * exactly this reason — while `boardForHost` and `postingId` live here and are
 * the platform's single answers to "which board is this?" and "which posting is
 * this?". This module is where the two meet, and it is the only place they are
 * wired together.
 *
 * ⚠️ **The board path skips the model entirely, and that is the point of
 * having it.** A Posting fetched here is assembled from fields the board itself
 * published, so there is no extraction to be wrong about, no prompt to inject
 * into, and no model call to pay for. What comes back is still validated against
 * {@link StoredPostingSchema} before it leaves — an actor is a community scraper
 * and its output is no more trusted for being structured.
 *
 * The general fetcher in `@workspace/agent-tools/page-extract` remains the path
 * for everything else, and "everything else" is most of the world: a Greenhouse
 * link, a Lever link, a company careers page and — because its actor takes
 * search-results URLs only — LinkedIn. A caller handles {@link
 * PostingFetch.status} `"unsupported"` by falling through to that one.
 */

/**
 * Which board answers a direct link, keyed by {@link JobBoard.name}.
 *
 * Thunks rather than a list of specs because each spec is generic in its own
 * actor's item type, and a heterogeneous array of them has no useful element
 * type. Keyed by the board's name rather than its host so that `JOB_BOARDS`
 * stays the one place a host is matched — `board-fetch.test.ts` asserts every
 * key here is a board that registry actually names, which is what stops a typo
 * silently disabling a board.
 *
 * LinkedIn's absence is deliberate and is not a gap to fill: its actor accepts
 * search-results URLs and has no input for a single job page. Adding a key for
 * it would route a LinkedIn link into a run that cannot answer it, where today
 * it falls straight through to the general fetcher.
 */
const BOARD_FETCHERS: Record<
  string,
  (url: string, deps: BoardPostingDeps) => ReturnType<typeof fetchBoardPosting>
> = {
  SEEK: (url, deps) => fetchBoardPosting(SEEK_SPEC, url, deps),
  Indeed: (url, deps) => fetchBoardPosting(INDEED_SPEC, url, deps),
}

/** Exported for the test that pairs it against `JOB_BOARDS`. */
export const BOARDS_FETCHED_BY_URL: readonly string[] =
  Object.keys(BOARD_FETCHERS)

/**
 * Fetched from a board, not a board's to fetch, or a sentence saying why not.
 *
 * The three branches are the caller's whole decision. `unsupported` means try
 * the general fetcher; `failed` means the board that owns this advertisement was
 * asked and could not answer, which is not something a second retrieval is
 * likely to fix and is a wait a person is already paying for.
 */
export type PostingFetch =
  | { status: "fetched"; board: string; posting: StoredPosting }
  | { status: "unsupported" }
  | { status: "failed"; message: string }

/** Injected in tests. Both default to the real thing. */
export interface PostingFetchDeps {
  fetch?: typeof globalThis.fetch
  apiToken?: string
}

/**
 * The advertisement at `url`, if a board we can ask serves it.
 *
 * `url` is the caller's — the one a person pasted — and it is what the returned
 * Posting carries. The board's own canonical link is used to *check* the answer
 * and is then discarded, so a Posting added by link and the same advertisement
 * found later by a Run agree on one `postingId` and merge into one row.
 */
export async function fetchPostingByUrl(
  url: string,
  deps: PostingFetchDeps = {}
): Promise<PostingFetch> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    // Not this module's refusal to make. A caller validates the URL before it
    // gets here, and answering `unsupported` sends an unparseable one to the
    // general fetcher, which fails it with a sentence about the link.
    return { status: "unsupported" }
  }

  const board = boardForHost(host)
  const fetchFrom = board && BOARD_FETCHERS[board.name]
  if (!fetchFrom) return { status: "unsupported" }

  const result = await fetchFrom(url, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.apiToken ? { apiToken: deps.apiToken } : {}),
    idFor: (candidate) => postingId({ url: candidate }),
  })

  if (result.status !== "fetched") return result

  // The URL is attached here, from the caller, exactly as the general path
  // attaches it after the extractor: what the board reported about its own link
  // has already done its job in the identity check above.
  //
  // `matchReason` is absent, and absent rather than empty. Nobody stated
  // criteria for a link somebody pasted, so there is no judgement to record —
  // see `stored-posting.ts`, which is why that field is optional at all.
  const parsed = StoredPostingSchema.safeParse({ ...result.posting, url })

  if (!parsed.success) {
    // An actor is a community scraper, and structured output is not validated
    // output. Reaching this means the board answered with something that is not
    // a Posting, which is a fault to report rather than a row to write.
    //
    // The zod detail goes to the log and not to the reader, the same rule the
    // Server Action follows for its own parse: which field failed is a fact
    // about this codebase, and the person holding the link can act on none of
    // it.
    console.error(
      `board-fetch: ${result.posting.board} returned an unusable advertisement for ${url}: ${z.prettifyError(parsed.error)}`
    )

    return {
      status: "failed",
      message: `That ${result.posting.board} link did not come back as a readable job advertisement. Try again in a moment.`,
    }
  }

  return {
    status: "fetched",
    board: result.posting.board,
    posting: parsed.data,
  }
}
