import type { StructuredToolInterface } from "@langchain/core/tools"

import {
  apifyBoardSearch,
  createBoardSearchTool,
  type ApifyBoardSpec,
  type BoardSearchDeps,
  type BoardSearchInput,
  type ResolvedBoardSearch,
} from "./apify-search.ts"
import type { PostingCatalog } from "./posting-catalog.ts"
import type { SearchLog } from "./search-log.ts"

/**
 * Indeed job search, via Apify's `misceres/indeed-scraper` actor.
 *
 * Everything that is not about Indeed lives in `apify-search.ts` — the token,
 * run timeout, clamp, failure split, description bound and rendering. What is
 * left here is the actor id, its request body, its field mapping, and the two
 * bounds its input schema cannot take.
 *
 * The tool's external shape is deliberately identical to `seek_search`'s, so a
 * scout sweeping a title across two boards writes the same call twice; where
 * the actor's input differs, the difference is absorbed below rather than
 * pushed into the schema the model reads.
 *
 * Measured live 2026-08-05 on a six-result Sydney search: ~15–20s per run,
 * $0.036 for six items, 77 KB of JSON. Caveats, same as SEEK: the actor is a
 * community scraper, not an Indeed product, and this tool sends a fixed,
 * minimal input — it returns data and performs no side effect.
 */

/** Apify spells actor ids with a tilde in a URL: `misceres/indeed-scraper`. */
const ACTOR_ID = "misceres~indeed-scraper"

/** The tool's name, exported so the scout can list its boards without building one. */
export const INDEED_TOOL_NAME = "indeed_search"

/**
 * Twenty, where SEEK defaults to forty. Descriptions no longer reach the model
 * from a search, so context is not the ceiling — but the actor charges per item
 * and Indeed's Australian inventory is thinner, so this stays the smaller
 * number.
 */
const DEFAULT_MAX_RESULTS = 20

/** Half of SEEK's ceiling, for the same reason. Still far past a scout pass. */
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
 * `externalApplyLink` is absent on purpose, not by oversight: it carries
 * Indeed's `from`/`tk`/`vjk` tracking parameters, where `url` is the clean
 * canonical `viewjob?jk=…` form. Posting identity is derived from the URL, so
 * two tracking-laden links to one advertisement would become two postings.
 * Verified over a repeated search — all four overlapping postings hashed
 * identically.
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
 * A posting with no readable listing date is **kept**: the actor returns only
 * live listings, so `daysOld` is a recency preference, not a correctness gate,
 * and dropping on absence would let one upstream field change silently empty
 * every search. Such a posting renders with no `listed:` line, so the missing
 * evidence is visible to the model.
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

export const INDEED_SPEC: ApifyBoardSpec<IndeedJob> = {
  board: "Indeed",
  toolName: INDEED_TOOL_NAME,
  actorId: ACTOR_ID,
  defaultMaxResults: DEFAULT_MAX_RESULTS,
  maxResultsLimit: MAX_RESULTS_LIMIT,
  defaultDaysOld: DEFAULT_DAYS_OLD,

  // Every key was confirmed against a live run on 2026-08-05; nothing is sent
  // that was not observed to be accepted. `parseCompanyDetails` is off — the
  // scout never reads an employer profile. `followApplyRedirects` is off — it
  // produces the tracking-laden links this tool exists to avoid.
  // `saveOnlyUniqueItems` is on: Indeed lists one advertisement under several
  // facets.
  //
  // `daysOld` and `workType` have no counterpart in the actor's input schema,
  // and inventing a plausible key would be worse than useless — the actor
  // ignores what it does not recognise, so the bound would look enforced and
  // would not be. Both are applied to returned items in `keepItem`.
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

  // One named advertisement rather than a search. `position` is absent
  // deliberately — the actor's `startUrls` accepts "category/search URLs,
  // company jobs URL … or detail/product URLs", so a query beside a start URL
  // would give it two jobs to do. `maxItemsPerSearch: 1` bounds what a URL that
  // is *not* a job page can turn into, and the identity check in
  // `board-posting.ts` is what refuses the result when it does.
  //
  // The three flags carry over from the search body unchanged, for the reasons
  // stated there: no company profile, no apply-redirect chasing — which is also
  // the path that produces tracking-laden links — and unique items only.
  byUrl: {
    buildRequestBody(url: string): Record<string, unknown> {
      return {
        startUrls: [{ url }],
        maxItemsPerSearch: 1,
        saveOnlyUniqueItems: true,
        parseCompanyDetails: false,
        followApplyRedirects: false,
      }
    },

    toAdvertisement(job: IndeedJob) {
      return {
        // `url`, never `externalApplyLink` — see the note on IndeedJob. It is
        // also what the identity check matches on, so the canonical form is the
        // only one that can agree with the pasted link.
        url: job.url,
        title: job.positionName,
        company: job.company,
        location: job.location,
        // Same rule as the search rendering: passed through when it parses and
        // dropped when it does not, so a value this tool could not read is never
        // stored as a date.
        postedAt:
          listedAtMillis(job) === undefined ? undefined : job.postingDateParsed,
        // Indeed publishes no teaser, so the summary comes off the head of the
        // description — which is where a job advertisement puts its substance.
        description: job.description,
      }
    },
  },
}

/**
 * Indeed's half of a board search, exported for its test and for anything that
 * wants the string without going through the tool wrapper.
 */
export async function apifyIndeedSearch(
  input: IndeedSearchInput,
  catalog: PostingCatalog,
  deps: IndeedSearchDeps = {},
  log?: SearchLog
): Promise<string> {
  return apifyBoardSearch(INDEED_SPEC, input, catalog, deps, log)
}

/**
 * Search Indeed's live listings.
 *
 * Named for the board, exactly as `seek_search` is: which inventory answered
 * the question is what the scout needs to know, and what the worker's search
 * gate counts.
 *
 * A factory rather than a ready-made tool, because every result it renders is
 * recorded in one run's catalog and named by it.
 */
export function createIndeedSearch(
  catalog: PostingCatalog,
  log: SearchLog
): StructuredToolInterface {
  return createBoardSearchTool(INDEED_SPEC, catalog, log, {
    source: "au.indeed.com",
    locationDescription:
      'Where, as Indeed writes it — "Sydney NSW", "Melbourne VIC", "Remote". Omit to search all of Australia.',
    workTypes: WORK_TYPES,
    workTypeDescription:
      "Restrict to one employment type, as Indeed labels it. Omit for all; postings that state no type are kept either way.",
  })
}
