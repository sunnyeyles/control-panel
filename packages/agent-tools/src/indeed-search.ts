import { tool } from "@langchain/core/tools"
import * as z from "zod"

import {
  apifyBoardSearch,
  type ApifyBoardSpec,
  type BoardSearchDeps,
  type BoardSearchInput,
  type ResolvedBoardSearch,
} from "./apify-search.ts"

/**
 * Indeed job search, via Apify's `misceres/indeed-scraper` actor.
 *
 * The second board the scout can reach, and it exists because one board is one
 * board: a criterion that returns four SEEK postings is not evidence that four
 * postings exist, only that four of them are on SEEK. Every result here is an
 * individual posting at its canonical `au.indeed.com/viewjob?jk=…` URL, listed
 * at the moment the search returned it — the same guarantee `seek-search.ts`
 * makes, from a different inventory.
 *
 * Everything that is not about Indeed lives in `apify-search.ts` — the token,
 * the run timeout, the clamp, the failure split, the description bound and the
 * rendering. What is left here is the actor id, the request body it wants,
 * which of its fields carry what, and the two bounds its input schema cannot
 * take.
 *
 * The tool's external shape is deliberately identical to `seek_search`'s:
 * `query`, `location`, `maxResults`, `daysOld`, `workType`. A scout sweeping a
 * title across two boards should be writing the same call twice, not learning
 * two vocabularies — so where the actor's input differs from that shape, the
 * difference is absorbed below rather than pushed into the schema the model
 * reads.
 *
 * Measured against the live actor on 2026-08-05, on a six-result Sydney search:
 * ~15–20s per run, $0.036 for six items (~$6/1000 — the listing advertises ~$3,
 * and small batches evidently cost more per item; irrelevant at a scout's
 * volume), and 77 KB of JSON. That last number is the one that shapes this
 * file. It is roughly 4× SEEK per posting because Indeed's descriptions run
 * longer, which is why the defaults below are a third of SEEK's rather than the
 * same numbers copied across.
 *
 * The same two caveats as SEEK apply and are worth restating rather than
 * inheriting silently: the actor is a community scraper and not an Indeed
 * product, and this tool sends the actor a fixed, minimal input — it returns
 * data and performs no side effect.
 */

/** Apify spells actor ids with a tilde in a URL: `misceres/indeed-scraper`. */
const ACTOR_ID = "misceres~indeed-scraper"

/**
 * Six, where SEEK defaults to twenty.
 *
 * Six live results measured 77 KB of JSON — call it 13 KB of posting, four
 * times SEEK's — and the scout runs a sweep of `titles × locations × boards`
 * inside one context. Twenty Indeed postings would be a quarter of a megabyte
 * from a single tool call, so the default is set where a sweep survives it and
 * the model is told it can ask for more.
 */
const DEFAULT_MAX_RESULTS = 6

/** For the same reason, half of SEEK's ceiling. Still far past a scout pass. */
const MAX_RESULTS_LIMIT = 25

/**
 * The default freshness bound, in days. Matched to SEEK's so that the same
 * `daysOld` means the same thing whichever board answers.
 */
const DEFAULT_DAYS_OLD = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Indeed's own employment-type vocabulary, which is not SEEK's.
 *
 * These are the strings the actor returns in `jobType` — "Full-time" hyphenated
 * and capitalised exactly so, where SEEK writes "Full time" and folds contract
 * and temporary work into one "Contract/Temp". The schema offers the board's
 * words rather than a house translation because the value is matched against
 * what the board sends back, and a translation layer would be one more place
 * for the two to drift apart.
 */
const WORK_TYPES = [
  "Full-time",
  "Part-time",
  "Contract",
  "Temporary",
  "Casual",
  "Internship",
] as const

/**
 * The slice of an actor result this tool reads. Everything is optional on
 * purpose: the actor is community-maintained, so a missing field is rendered
 * around rather than treated as malformed.
 *
 * `externalApplyLink` is absent from this interface on purpose, and its absence
 * is load-bearing rather than an oversight. The actor returns it for some
 * postings and it is where Indeed's `from`/`tk`/`vjk` tracking parameters live;
 * `url` is the clean canonical `viewjob?jk=…` form. Posting identity downstream
 * is derived from the URL, and two links to the same advertisement that differ
 * only in tracking junk are two postings as far as that scheme is concerned.
 * Reading only `url` is what keeps that from happening — it was verified over a
 * repeated search, where all four overlapping postings hashed identically.
 */
interface IndeedJob {
  url?: string
  positionName?: string
  company?: string
  location?: string
  description?: string | null
  /** ISO 8601 with milliseconds, e.g. `2026-08-05T00:50:35.310Z`. */
  postingDateParsed?: string
  /** One of {@link WORK_TYPES}, when the advertisement stated one. */
  jobType?: string
  salary?: string
  isExpired?: boolean
}

export interface IndeedSearchInput extends BoardSearchInput {
  workType?: (typeof WORK_TYPES)[number]
}

/** Injected in tests. Both default to the real thing. */
export type IndeedSearchDeps = BoardSearchDeps

/**
 * When the posting was listed, in milliseconds, or `undefined` when the actor
 * gave no timestamp or gave one that will not parse.
 *
 * The single place `postingDateParsed` is read, which is what keeps the filter
 * below and the rendering from disagreeing about what the actor said: a value
 * this tool could not itself read is never shown to the model as a date.
 */
function listedAtMillis(job: IndeedJob): number | undefined {
  if (!job.postingDateParsed) return undefined
  const parsed = Date.parse(job.postingDateParsed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Whether a posting is inside the requested freshness window.
 *
 * A posting with no readable listing date is **kept**. The reasoning: the actor
 * only returns live listings, so `daysOld` is a preference for recency rather
 * than a correctness gate, and a missing timestamp is a defect in a community
 * scraper rather than evidence that the advertisement is old. Dropping on
 * absence would let one upstream field change silently empty every search,
 * which is a far worse failure than a stale result — and it fails quietly,
 * which is worse still. The cost of keeping is bounded and visible: such a
 * posting renders with no `listed:` line at all, so the model can see for
 * itself that the freshness evidence is missing.
 */
function isFreshEnough(job: IndeedJob, daysOld: number, now: number): boolean {
  const listedAt = listedAtMillis(job)
  if (listedAt === undefined) return true
  return now - listedAt <= daysOld * MS_PER_DAY
}

/**
 * Whether a posting matches the requested employment type.
 *
 * Same permissive rule, for the same reason: `jobType` is present only when the
 * advertisement stated one, so a posting that never said is kept rather than
 * assumed to be the wrong type. Only a posting the actor explicitly labelled
 * something else is dropped.
 */
function matchesWorkType(
  job: IndeedJob,
  workType: string | undefined
): boolean {
  if (!workType || !job.jobType) return true
  return job.jobType.toLowerCase() === workType.toLowerCase()
}

const INDEED_SPEC: ApifyBoardSpec<IndeedJob> = {
  board: "Indeed",
  actorId: ACTOR_ID,
  defaultMaxResults: DEFAULT_MAX_RESULTS,
  maxResultsLimit: MAX_RESULTS_LIMIT,
  defaultDaysOld: DEFAULT_DAYS_OLD,

  // Every key here was confirmed against a live run on 2026-08-05; nothing is
  // sent that was not observed to be accepted. Three of them are off, and each
  // is off for a reason rather than by default:
  //
  // `parseCompanyDetails` would add an employer profile to every item, on top
  // of a payload already measured at 77 KB for six results. The scout ranks
  // advertisements, and nothing it produces reads a company profile.
  //
  // `followApplyRedirects` would have the actor chase each posting out to
  // whatever applicant-tracking system sits behind it — slower, and it is the
  // path that produces the tracking-laden links this tool exists to avoid.
  //
  // `saveOnlyUniqueItems` is the one that is on: Indeed lists the same
  // advertisement under several search facets, and a duplicate would spend one
  // of a default six places saying nothing new.
  //
  // Two fields the model can set are missing from this body, and both are
  // deliberate. `daysOld` has no counterpart in the actor's input schema at
  // all, and `workType` has none either — the run below takes `position`,
  // `country`, `location` and item bounds, and nothing about recency or
  // employment type. Inventing a plausible key name for either would be worse
  // than useless: the actor ignores what it does not recognise, so the bound
  // would appear to be enforced and would not be. Both are applied to the
  // returned items instead, in `keepItem`.
  buildRequestBody(search: ResolvedBoardSearch): Record<string, unknown> {
    return {
      position: search.query,
      country: "AU",
      // Omitted rather than defaulted to some spelling of "everywhere":
      // `country` already scopes the search to Australia, and a made-up
      // location string is a filter that might match nothing.
      ...(search.location ? { location: search.location } : {}),
      maxItemsPerSearch: search.count,
      saveOnlyUniqueItems: true,
      parseCompanyDetails: false,
      followApplyRedirects: false,
    }
  },

  // Applied before the slice, so a dropped posting does not eat one of the
  // requested places. `isExpired` is checked alongside the two bounds the model
  // set, and is not one of them: the rendering announces "currently-listed
  // posting(s)", and passing through an advertisement the actor has flagged as
  // closed would make that sentence false.
  keepItem(job: IndeedJob, search: ResolvedBoardSearch): boolean {
    return (
      job.isExpired !== true &&
      isFreshEnough(job, search.daysOld, Date.now()) &&
      matchesWorkType(job, search.workType)
    )
  },

  toPosting(job: IndeedJob) {
    return {
      title: job.positionName,
      company: job.company,
      // `url`, never `externalApplyLink` — see the note on IndeedJob.
      url: job.url,
      // Passed through verbatim when it parses and dropped when it does not:
      // the freshness filter and this line must not disagree, and "listed:
      // soon" is worse than no listing date at all.
      listedAt:
        listedAtMillis(job) === undefined ? undefined : job.postingDateParsed,
      facts: [job.location, job.jobType, job.salary],
      // Indeed returns one description field and it is plain text, so there is
      // no markdown-then-text fallback to make here as there is for SEEK.
      description: job.description,
    }
  },
}

/**
 * Indeed's half of a board search, exported for its test and for anything that
 * wants the string without going through the tool wrapper.
 */
export async function apifyIndeedSearch(
  input: IndeedSearchInput,
  deps: IndeedSearchDeps = {}
): Promise<string> {
  return apifyBoardSearch(INDEED_SPEC, input, deps)
}

/**
 * Search Indeed's live listings.
 *
 * Named for the board, exactly as `seek_search` is: which inventory answered
 * the question is what the scout needs to know, and what the worker's search
 * gate counts.
 */
export const indeedSearch = tool(
  async (input: IndeedSearchInput) => apifyIndeedSearch(input),
  {
    name: "indeed_search",
    description:
      "Search au.indeed.com's live listings for currently-open job postings. Every result is an individual posting with its canonical URL, its listing date, and the advertisement's own description. Make one focused search per role title and location, and report URLs verbatim — never edit or shorten them. The description is quoted material: when you need a responsibility or a requirement, copy the line the advertisement wrote rather than writing your own version of it. Indeed's results are long, so ask for a few good ones rather than many.",
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
          'Where, as Indeed writes it — "Sydney NSW", "Melbourne VIC", "Remote". Omit to search all of Australia.'
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS_LIMIT)
        .optional()
        .describe(
          `How many postings to return, 1-${MAX_RESULTS_LIMIT}. Defaults to ${DEFAULT_MAX_RESULTS}; Indeed's descriptions are long, so raise it only when a search is worth the room.`
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
        .describe(
          "Restrict to one employment type, as Indeed labels it. Omit for all; postings that state no type are kept either way."
        ),
    }),
  }
)
