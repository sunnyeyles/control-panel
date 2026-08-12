import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { extractPageViaApify } from "@workspace/agent-tools/pages/page-extract-apify"
import {
  extractPage,
  type PageExtractResult,
} from "@workspace/agent-tools/pages/page-extract"
import type { Agent } from "@workspace/agents"
import {
  fetchPostingByUrl,
  type PostingFetch,
} from "@workspace/agents/board-fetch"
import { invokeTracedAgent } from "@/lib/agents/invoke-traced-agent"
import { parsePostedAt } from "@workspace/agents/posted-at"
import { postingId } from "@workspace/agents/posting-id"
import {
  createPostingExtractor as defaultPostingExtractor,
  parsePostingExtraction,
  toPostingExtractionPrompt,
} from "@workspace/agents/posting-extractor"
import type { StoredPosting } from "@workspace/agents/stored-posting"
import {
  postingPayload,
  recordLinkedPosting,
  titleExclusions,
  type PrismaClient,
} from "@workspace/db"
import { isExcludedTitle } from "@workspace/job-search"
import { z } from "zod"

/**
 * Adding a Posting the user found themselves, by pasting its link. Nothing here
 * imports Next, like everything else under `lib/`.
 *
 * **Two retrieval paths, cheaper first.** A board whose actor takes a single
 * posting — SEEK and Indeed — answers with published fields and no model at all.
 * Everything else goes through the general fetchers (Tavily, then Apify's
 * Website Content Crawler once) and the Posting Extractor. LinkedIn is in the
 * second group: its actor takes search-results URLs, not job pages.
 *
 * ⚠️ **A supported board that fails does not fall through to the general
 * fetchers.** It has already spent up to 30s, and a general crawler is least
 * likely to get past the board that just refused, so the board's failure is
 * reported in its own words.
 *
 * Three structural properties, holding on both paths:
 *
 * 1. **Nothing in this process opens a socket to the host the user named** — the
 *    retrieval is a POST to Tavily or Apify. No SSRF surface, no redirect chain
 *    to bound, no streaming response to cut off.
 * 2. **The page reaches exactly one agent, and that agent has no tools.** The
 *    Posting Extractor holds no CV, no instructions and no stored document, and
 *    its answer is schema-validated before anything is written.
 * 3. **Nothing outside this module handles the URL.** `postingId()` derives the
 *    identity from what the user pasted; a link copied off the page cannot
 *    become the Posting's address, and neither can the board's canonical form.
 *
 * The caller is authorized before the body is touched, and an already-tracked
 * advertisement is answered before the fetch and before the model — the step
 * order in {@link createAddByLinkActions} is the design.
 */

/**
 * A URL long enough for any advertisement and short enough not to be a payload.
 *
 * Bounded before it becomes a request, for the reason the query-string rules in
 * `apps/dashboard/CLAUDE.md` give about `page`: a value from outside that
 * reaches a service should be bounded on this side, not on theirs.
 */
const MAX_URL_CHARS = 2_048

/**
 * ⚠️ **`http` and `https` only, checked here rather than left to `z.url()`.**
 * Zod accepts any scheme a URL parser does, so `file:`, `data:` and
 * `javascript:` all pass it, and none is something to hand to a fetcher.
 */
const urlSchema = z
  .url()
  .max(MAX_URL_CHARS)
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "only http and https"
  )

/** What to say for a link that is not one. */
const NOT_A_URL = "That does not look like a link. Paste the full web address."

/**
 * The extractor ran and what came back could not be used.
 *
 * One message for three causes — the call failed, the final message was empty,
 * or the JSON did not match the schema — for the reason `EXTRACTION_FAILED` in
 * `suggest-criteria-actions.ts` gives: none of the three is anything the person
 * holding the link can act on differently, and all three have the same remedy.
 * The distinction is in the server log.
 */
export const READ_FAILED =
  "That page could not be read as a job advertisement. Try again in a moment."

/** Already on the page, so there is nothing to add and nothing was spent. */
export const ALREADY_TRACKED =
  "That posting is already in your list — look for it in the table below."

export interface AddByLinkActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The client, resolved per call rather than held, so the factory constructs
   * nothing at module scope. Called after validation, which is what lets a test
   * prove nothing was queried.
   */
  getPrisma: () => PrismaClient
  /**
   * The board path, tried first. Defaults to the real router, which reads
   * `APIFY_TOKEN` **inside the call** and only when a board actually claims the
   * link — a Greenhouse URL never reaches Apify and so never needs the token.
   */
  fetchFromBoard?: (url: string) => Promise<PostingFetch>
  /**
   * How the page is retrieved when no board claims the link. Defaults to
   * Tavily then, on `status: "failed"` only, Apify's Website Content Crawler —
   * reading `TAVILY_API_KEY` and, if needed, `APIFY_TOKEN` **inside the call**.
   *
   * A test passes one that answers from a fixture, which is also how "a
   * duplicate costs no fetch" is asserted rather than asserted about. The
   * injection replaces the whole composition.
   */
  fetchPage?: (url: string) => Promise<PageExtractResult>
  /**
   * The extractor. Defaults to the real agent, which reads `OPENAI_API_KEY`
   * when constructed — hence a factory **called inside the action**, never at
   * module scope, exactly as `SuggestCriteriaActionsDeps.createProfileExtractor` is.
   */
  createPostingExtractor?: () => Agent
  /** Overridden in tests, so an assertion can name the instant. */
  now?: () => Date
}

export interface AddByLinkActions {
  addPostingByLink: (
    state: ActionState,
    formData: FormData
  ) => Promise<ActionState>
}

export function createAddByLinkActions(
  deps: AddByLinkActionsDeps
): AddByLinkActions {
  const fetchFromBoard =
    deps.fetchFromBoard ?? ((url: string) => fetchPostingByUrl(url))
  const fetchPage =
    deps.fetchPage ??
    (async (url: string) => {
      const fromTavily = await extractPage(url)
      if (fromTavily.status !== "failed") return fromTavily
      return extractPageViaApify(url)
    })
  const createPostingExtractor =
    deps.createPostingExtractor ?? (() => defaultPostingExtractor())
  const now = deps.now ?? (() => new Date())

  async function addPostingByLink(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched. For a Server Action `proxy.ts` is not a
    // second layer — the auth SDK cannot evaluate a POST session — so this is
    // the only real check on the path.
    const caller = await requireUser(deps.getUser, "postings")
    if (!caller.ok) return fail(caller.message)

    const parsed = urlSchema.safeParse(formData.get("url"))
    if (!parsed.success) return fail(NOT_A_URL)

    const url = parsed.data

    // ⚠️ **Never a rule restated here.** `postingId()` normalises the URL —
    // tracking parameters dropped, survivors sorted, default port removed,
    // trailing slash stripped — and it is what makes a pasted link and the same
    // advertisement found later by a Run agree on one row. A second
    // implementation disagreeing by one rule would mint an id nothing else
    // agrees with, splitting one Posting in two and stranding the status a
    // person set on the first.
    const id = postingId({ url })

    // Before the fetch and before the model, so a duplicate paste costs
    // nothing — the same placement `suggest-criteria-actions.ts` uses for its
    // refusals. `recordLinkedPosting`'s `DO NOTHING` covers the race this check
    // cannot; this covers the cost.
    try {
      if (await postingPayload(deps.getPrisma(), caller.userId, id)) {
        return fail(ALREADY_TRACKED)
      }
    } catch (error) {
      console.error("postings: could not check for an existing posting", error)
      return fail("Something went wrong.")
    }

    // The board that issued the link, where one can be asked for a single
    // advertisement. This is the whole reason the two paths exist: SEEK and
    // Indeed publish the fields a Posting needs, so their answer needs no
    // reading and costs no model call.
    let fromBoard: PostingFetch
    try {
      fromBoard = await fetchFromBoard(url)
    } catch (error) {
      // A rejected or missing `APIFY_TOKEN` throws rather than answering, so a
      // deployment fault is not reported to the user as a broken link.
      console.error("postings: could not reach the board fetcher", error)
      return fail("Something went wrong.")
    }

    // No second retrieval after a board's failure — see the note at the head of
    // this file. The board that owns the advertisement was asked and could not
    // answer, and saying so beats spending more of somebody's wait on the path
    // least likely to get past that board.
    if (fromBoard.status === "failed") return fail(fromBoard.message)

    let posting: StoredPosting

    if (fromBoard.status === "fetched") {
      // Already validated against `StoredPostingSchema`, and already carrying
      // the URL from this module rather than from the board.
      posting = fromBoard.posting
    } else {
      let page
      try {
        page = await fetchPage(url)
      } catch (error) {
        // Same split, same reason: a rejected or missing `TAVILY_API_KEY` or
        // `APIFY_TOKEN` throws rather than answering.
        console.error("postings: could not reach the page fetcher", error)
        return fail("Something went wrong.")
      }

      if (page.status === "failed") return fail(page.message)

      let extraction
      try {
        extraction = parsePostingExtraction(
          await invokeTracedAgent(createPostingExtractor(), {
            name: "posting-extract",
            route: "/jobs",
            userId: caller.userId,
            prompt: toPostingExtractionPrompt(page.page.markdown),
          })
        )
      } catch (error) {
        console.error("postings: the posting extractor failed", error)
        return fail(READ_FAILED)
      }

      // A refusal is data, not an error: a search-results page, a careers index
      // or a sign-in wall are ordinary things to find behind a link, and the
      // reason the extractor gives is more useful than anything this module
      // could say about them.
      if (extraction.kind === "not-a-posting") {
        return fail(
          `That page is not a single job advertisement. ${extraction.reason}`
        )
      }

      // The URL is attached here and comes from the form, never from the model.
      posting = { ...extraction.posting, url }
    }

    /*
      ⚠️ **Refused rather than added, and the alternative is worse.** The
      Postings table hides a row whose title carries one of these words, so
      adding one would write a row that is invisible the instant it exists —
      the user would paste a link, be told it was added, and find nothing. The
      word is named because the filter is account-wide and was probably set
      weeks ago about a different search entirely.

      Deliberately *after* the fetch: what is checked is the title the
      advertisement actually carries, which nothing knows until the page or the
      board has answered. Checking the URL for the word instead would be a
      different rule, and a wrong one.
    */
    let blocked: string | undefined
    try {
      blocked = (await titleExclusions(deps.getPrisma(), caller.userId)).find(
        (term) => isExcludedTitle(posting.title, [term])
      )
    } catch (error) {
      // A settings read that failed must not cost somebody their paste. The
      // filter is about tidying a list, and the honest degradation is to add
      // the advertisement they explicitly asked for.
      console.error("postings: could not read the title filters", error)
    }

    if (blocked !== undefined) {
      return fail(
        `“${blocked}” is one of your excluded title words, so “${posting.title}” would be hidden as soon as it was added. Change your filters in Schedules first.`
      )
    }

    // The advertisement's own words survive in the payload; the column takes
    // only what `parsePostedAt` will call a date. The same rule the worker
    // applies to a Run's findings, called from the same module — a second copy
    // of it is what `posted-at.ts` exists to prevent.
    const postedAt = parsePostedAt(posting.postedAt)

    let inserted: boolean
    try {
      inserted = await recordLinkedPosting(deps.getPrisma(), {
        userId: caller.userId,
        seenAt: now(),
        posting: {
          postingId: id,
          title: posting.title,
          company: posting.company,
          location: posting.location,
          url,
          ...(postedAt ? { postedAt } : {}),
          payload: posting,
        },
      })
    } catch (error) {
      console.error("postings: could not record the posting", error)
      return fail("Something went wrong.")
    }

    if (!inserted) return fail(ALREADY_TRACKED)

    return {
      status: "success",
      message: `Added ${posting.title} at ${posting.company}.`,
      // The Posting's own id: a second paste of the same link is refused
      // above, so there is no repeat submission for a stable key to collapse.
      resetKey: id,
    }
  }

  return { addPostingByLink }
}
