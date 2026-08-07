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
 * LinkedIn job search, via Apify's `curious_coder/linkedin-jobs-scraper` actor.
 *
 * The third board the scout reaches, and the awkward one. Everything that is
 * not about LinkedIn lives in `apify-search.ts` — the token, the run timeout,
 * the clamp, the failure split, the description bound and the rendering — so
 * what is left here is the actor id, the request body it wants, and which of
 * its fields carry what. Two of those are unlike any other board:
 *
 * The actor takes a prebuilt *search URL*, not search parameters. So the
 * request body is composed rather than filled in: keywords and location go into
 * the query string, `daysOld` becomes LinkedIn's seconds-based recency filter
 * `f_TPR=r…`, and `workType` becomes its single-letter employment-type code
 * `f_JT`. None of that reaches the schema below. The scout asks all three
 * boards the same five questions and does not know it is talking to a different
 * kind of actor.
 *
 * And `count` has a hard floor of ten: the actor rejects a smaller run outright
 * with `Field input.count must be >= 10` rather than returning fewer items. A
 * floor is an actor's quirk and has no business appearing in the schema a model
 * reads, so `minItemsPerRun` asks for ten and the shared code slices the
 * surplus back off — a `maxResults: 3` search still returns three postings.
 *
 * The terms question here is its own decision, not SEEK's carried over.
 * `curious_coder/linkedin-jobs-scraper` is a community scraper and not a
 * LinkedIn product; LinkedIn publishes no jobs search API, and its user
 * agreement prohibits automated collection. There is no compliant option to
 * prefer instead — the partner programme is for posting roles, and every other
 * route on offer wants a personal account's session cookies, which would mean
 * putting a real member account behind every run. This actor needs no account
 * at all, so the reach is read-only, anonymous, and stops at what a signed-out
 * visitor could see. Using it was an explicit product decision taken with that
 * in view, not a technical default.
 */

const ACTOR_ID = "curious_coder~linkedin-jobs-scraper"

/** The tool's name, exported so the scout can list its boards without building one. */
export const LINKEDIN_TOOL_NAME = "linkedin_search"

/**
 * Enough candidates for one focused search to be worth making.
 *
 * Was 20, when a result meant the whole advertisement. A result is now two
 * lines, so this is set on how many postings are worth ranking rather than on
 * what a context can hold — matched to SEEK's, since the two boards carry
 * comparable inventory here.
 */
const DEFAULT_MAX_RESULTS = 40

/**
 * A scout pass ranks a handful of matches; it has no use for hundreds. Well
 * under the 1,000 postings one search URL can page through.
 */
const MAX_RESULTS_LIMIT = 50

/**
 * The default freshness bound, in days. The point of querying live inventory is
 * that nothing stale comes back; this keeps even a quiet criterion from
 * dredging up postings a month past their interview rounds.
 */
const DEFAULT_DAYS_OLD = 30

/**
 * The smallest run the actor accepts. Measured on 2026-08-05: nine below it and
 * the run fails before it starts, with `Field input.count must be >= 10`.
 */
const MIN_ITEMS_PER_RUN = 10

const SECONDS_PER_DAY = 24 * 60 * 60

/**
 * Where to look when the search does not say.
 *
 * LinkedIn's search is worldwide without a location, which would make the one
 * board that answered a bare query answer it with postings in countries nobody
 * asked about. SEEK defaults to "All Australia" and Indeed pins `country: "AU"`;
 * this is the same bound written the way LinkedIn writes places.
 */
const DEFAULT_LOCATION = "Australia"

/** The employment types a search can be narrowed to, as the model reads them. */
const WORK_TYPES = [
  "Full time",
  "Part time",
  "Contract",
  "Temporary",
  "Internship",
  "Volunteer",
] as const

type LinkedinWorkType = (typeof WORK_TYPES)[number]

/**
 * The same six, as LinkedIn's `f_JT` filter writes them.
 *
 * The codes are the board's private vocabulary and stay private: a model that
 * had to know "C" means contract would be a model that knows which board it is
 * searching, which is exactly what the shared input shape exists to avoid.
 */
const EMPLOYMENT_TYPE_CODES: Record<LinkedinWorkType, string> = {
  "Full time": "F",
  "Part time": "P",
  Contract: "C",
  Temporary: "T",
  Internship: "I",
  Volunteer: "V",
}

/**
 * The slice of an actor result this tool reads. Everything is optional on
 * purpose: the actor is community-maintained, so a missing field is rendered
 * around rather than treated as malformed.
 *
 * `applyUrl` is deliberately absent. The actor returns it, and it was the empty
 * string on every one of the postings measured on 2026-08-05 — reading it would
 * put an always-blank fact in front of the model. `link` is the posting.
 */
interface LinkedinJob {
  title?: string
  companyName?: string
  location?: string
  link?: string
  /** Date only, no time — the actor reports `2026-07-30`, not a timestamp. */
  postedAt?: string
  employmentType?: string
  seniorityLevel?: string
  salary?: string
  descriptionText?: string | null
}

export interface LinkedinSearchInput extends BoardSearchInput {
  workType?: LinkedinWorkType
}

/** Injected in tests. Both default to the real thing. */
export type LinkedinSearchDeps = BoardSearchDeps

/**
 * The search page the actor is pointed at, with every filter already applied.
 *
 * Values are escaped one at a time rather than through `URLSearchParams`, which
 * writes a space as `+`. Both are valid in a query string, but `%20` is the
 * form the live runs on 2026-08-05 used, and an actor that fetches this URL as
 * a browser would is not the place to find out whether the difference matters.
 */
function buildSearchUrl(search: ResolvedBoardSearch): string {
  const parameters: [string, string][] = [
    ["keywords", search.query],
    ["location", search.location ?? DEFAULT_LOCATION],
  ]

  // LinkedIn's recency filter is seconds, not days: `f_TPR=r604800` is "listed
  // in the last week". Unlike SEEK's `daysOld` this is a URL filter, so the
  // bound is applied by LinkedIn's own search and no post-fetch filter is
  // needed.
  parameters.push(["f_TPR", `r${search.daysOld * SECONDS_PER_DAY}`])

  // `ResolvedBoardSearch` carries `workType` as a bare string — the shared half
  // has no board's vocabulary in it — so an unrecognised value looks up as
  // `undefined` and the filter is left off rather than sent as nonsense.
  const codes: Record<string, string | undefined> = EMPLOYMENT_TYPE_CODES
  const code = search.workType ? codes[search.workType] : undefined
  if (code) parameters.push(["f_JT", code])

  const query = parameters
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&")

  return `https://www.linkedin.com/jobs/search/?${query}`
}

const LINKEDIN_SPEC: ApifyBoardSpec<LinkedinJob> = {
  board: "LinkedIn",
  actorId: ACTOR_ID,
  defaultMaxResults: DEFAULT_MAX_RESULTS,
  maxResultsLimit: MAX_RESULTS_LIMIT,
  defaultDaysOld: DEFAULT_DAYS_OLD,
  minItemsPerRun: MIN_ITEMS_PER_RUN,

  // Three fields, and the first is a whole search page. `scrapeCompany` stays
  // off: it visits each employer's LinkedIn profile for company-level detail
  // the scout is not ranking on, at a per-item cost the run does not need to
  // pay. The postings themselves already carry their description.
  buildRequestBody(search: ResolvedBoardSearch): Record<string, unknown> {
    return {
      urls: [buildSearchUrl(search)],
      count: search.count,
      scrapeCompany: false,
    }
  },

  toPosting(job: LinkedinJob) {
    return {
      title: job.title,
      company: job.companyName,
      // Passed through exactly as the actor returned it, tracking parameters
      // and all — `au.linkedin.com/jobs/view/…?position=&pageNum=&refId=…`,
      // even though the search asked `www.linkedin.com`. It goes to the catalog
      // and never to the model: eighty characters of per-search decoration is
      // precisely what a model cannot transcribe reliably, and the seven runs
      // that proved it are recorded in the worker's `resolve-postings.ts`.
      // Stabilising posting identity across those parameters is a separate job,
      // done per-host in `packages/agents/src/job-boards.ts`.
      url: job.link,
      listedAt: job.postedAt,
      facts: [job.location, job.employmentType, job.seniorityLevel, job.salary],
      description: job.descriptionText,
    }
  },
}

/**
 * LinkedIn's half of a board search, exported for its test and for anything
 * that wants the string without going through the tool wrapper.
 */
export async function apifyLinkedinSearch(
  input: LinkedinSearchInput,
  catalog: PostingCatalog,
  deps: LinkedinSearchDeps = {}
): Promise<string> {
  return apifyBoardSearch(LINKEDIN_SPEC, input, catalog, deps)
}

/**
 * Search LinkedIn's live listings.
 *
 * Named for the board, unlike `web_search`: which inventory answers the
 * question is exactly what the scout needs to know, and what the worker's
 * search gate counts.
 *
 * A factory rather than a ready-made tool, because every result it renders is
 * recorded in one run's catalog and named by it.
 */
export function createLinkedinSearch(
  catalog: PostingCatalog
): StructuredToolInterface {
  return tool(
    async (input: LinkedinSearchInput) => apifyLinkedinSearch(input, catalog),
    {
      name: LINKEDIN_TOOL_NAME,
      description:
        "Search LinkedIn's live job listings for currently-open postings. Every result is an individual posting with an id, its listing date and a teaser — call get_posting_details with those ids to read the advertisements themselves. Make one focused search per role title and location.",
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
            'Where, as LinkedIn writes it — "Sydney, New South Wales, Australia", "Melbourne, Victoria, Australia", "Australia". Defaults to all of Australia.'
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
          .enum(WORK_TYPES)
          .optional()
          .describe("Restrict to one employment type. Omit for all."),
      }),
    }
  )
}
