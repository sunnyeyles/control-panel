import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import * as z from "zod"

import {
  apifyBoardSearch,
  type ApifyBoardSpec,
  type BoardSearchDeps,
  type BoardSearchInput,
  type ResolvedBoardSearch,
} from "./apify-search.ts"
import type { PostingCatalog } from "./posting-catalog.ts"

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
 * Everything that is not about SEEK lives in `apify-search.ts` — the token, the
 * run timeout, the clamp, the failure split, the description bound and the
 * rendering are shared with every other board. What is left here is the actor
 * id, the request body it wants, and which of its fields carry what.
 *
 * Every result carries the advertisement's full description into the catalog,
 * because the actor is asked for it — `fetchDetails`, which was off until the
 * cost of turning it on was measured rather than assumed. Without it the teaser
 * and three bullet points are everything a posting has, which is enough to
 * summarise a role and not enough to argue anyone into one. What reaches the
 * model is the teaser; the description is read back by id through
 * `posting-details.ts`. See the comment on the request body for what the flag
 * actually costs.
 *
 * Two caveats, stated rather than hidden. The actor is a community scraper,
 * not a SEEK product, and SEEK's terms prohibit automated collection — using
 * it was an explicit product decision, not a technical default. And the actor
 * itself accepts webhook, Telegram and Slack notification fields that this
 * tool never sends: the input schema below is the scout's entire reach, which
 * is what keeps "a scraper returns data and performs no side effects"
 * structural rather than a prompt line.
 */

const ACTOR_ID = "unfenced-group~seek-com-au-scraper"

/** The tool's name, exported so the scout can list its boards without building one. */
export const SEEK_TOOL_NAME = "seek_search"

/**
 * Enough candidates for one focused search to be worth making.
 *
 * Was 20, when a result meant the whole advertisement and twenty of them meant
 * ~79 KB of context. A result is now two lines, so the ceiling on this stopped
 * being the model's context and started being how many postings are worth
 * ranking — and a broad title in a capital city has more than twenty.
 */
const DEFAULT_MAX_RESULTS = 40

/** A scout pass ranks a handful of matches; it has no use for hundreds. */
const MAX_RESULTS_LIMIT = 50

/**
 * The default freshness bound, in days. The point of querying live inventory
 * is that nothing stale comes back; this keeps even a quiet criterion from
 * dredging up postings a month past their interview rounds.
 */
const DEFAULT_DAYS_OLD = 30

/**
 * The slice of an actor result this tool reads. Everything is optional on
 * purpose: the actor is community-maintained, so a missing field is rendered
 * around rather than treated as malformed.
 *
 * `descriptionMarkdown` and `descriptionText` arrive only when the request
 * sets `fetchDetails`; without it the actor returns both as `null`, which is
 * why enabling that flag and reading the field are one change rather than two.
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
  descriptionMarkdown?: string | null
  descriptionText?: string | null
}

export interface SeekSearchInput extends BoardSearchInput {
  workType?: "Full time" | "Part time" | "Contract/Temp" | "Casual/Vacation"
}

/** Injected in tests. Both default to the real thing. */
export type SeekSearchDeps = BoardSearchDeps

const SEEK_SPEC: ApifyBoardSpec<SeekJob> = {
  board: "SEEK",
  actorId: ACTOR_ID,
  defaultMaxResults: DEFAULT_MAX_RESULTS,
  maxResultsLimit: MAX_RESULTS_LIMIT,
  defaultDaysOld: DEFAULT_DAYS_OLD,

  // `fetchDetails` is on, and the comment it replaces claimed it would triple
  // the scrape time. Measured, it does not: over six paired runs of the same
  // 20-result Sydney search on 2026-08-03, off averaged 10.3s and on averaged
  // 10.2s — 0.99x, with the two spreads (9.2–11.6s and 9.4–10.6s) overlapping
  // completely. The actor fetches every description in one batched GraphQL
  // call, so what dominates a run is the container start, not the number of
  // pages. That leaves no scrape budget to weigh against the benefit, and the
  // benefit is the point: without this flag the actor returns
  // `descriptionMarkdown: null`, and a teaser plus three bullets is all a
  // posting carries.
  //
  // It used to cost context too — ~79 KB across 20 results, every byte of it in
  // front of the model. It no longer does: descriptions go into the catalog and
  // are read back only for the shortlist, so the flag now costs nothing at all.
  buildRequestBody(search: ResolvedBoardSearch): Record<string, unknown> {
    return {
      searchQuery: search.query,
      location: search.location ?? "All Australia",
      country: "AU",
      fetchDetails: true,
      maxItems: search.count,
      daysOld: search.daysOld,
      sortMode: "ListedDate",
      ...(search.workType ? { workType: search.workType } : {}),
    }
  },

  toPosting(job: SeekJob) {
    // Markdown in preference to plain text: the headings and bullets are what
    // make a requirements section findable, and a reader copying a requirement
    // word for word needs the line breaks the plain rendering flattens. First
    // non-empty rather than first non-null — the actor returns `null` for a
    // description it did not fetch and `""` for one that came back blank, and
    // falling through both is what makes the plain rendering a real fallback.
    const description = [job.descriptionMarkdown, job.descriptionText]
      .map((value) => value?.trim() ?? "")
      .find((value) => value.length > 0)

    return {
      title: job.title,
      company: job.company,
      url: job.url,
      listedAt: job.publishDateISO,
      facts: [job.location, job.workType, job.workArrangement, job.salaryLabel],
      teaser: job.teaser,
      bullets: job.bulletPoints,
      description,
    }
  },
}

/**
 * SEEK's half of a board search, exported for its test and for anything that
 * wants the string without going through the tool wrapper.
 */
export async function apifySeekSearch(
  input: SeekSearchInput,
  catalog: PostingCatalog,
  deps: SeekSearchDeps = {}
): Promise<string> {
  return apifyBoardSearch(SEEK_SPEC, input, catalog, deps)
}

/**
 * Search SEEK's live listings.
 *
 * Named for the board, unlike `web_search`: which inventory answers the
 * question is exactly what the scout needs to know, and what the worker's
 * search gate counts.
 *
 * A factory rather than a ready-made tool, because every result it renders is
 * recorded in one run's catalog and named by it.
 */
export function createSeekSearch(
  catalog: PostingCatalog
): StructuredToolInterface {
  return tool(
    async (input: SeekSearchInput) => apifySeekSearch(input, catalog),
    {
      name: SEEK_TOOL_NAME,
      description:
        "Search seek.com.au's live listings for currently-open job postings. Every result is an individual posting with an id, its listing date and a teaser — call get_posting_details with those ids to read the advertisements themselves. Make one focused search per role title and location.",
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
}
