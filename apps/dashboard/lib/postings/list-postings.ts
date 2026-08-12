import { StoredPostingSchema } from "@workspace/agents/stored-posting"
import {
  listPostingPage,
  POSTING_STATUSES,
  titleExclusions,
  type PostingListRow,
  type PostingOrder,
  type PostingStatus,
  type PrismaClient,
} from "@workspace/db"
import { titleMatchPattern } from "@workspace/job-search"

import { formatCalendarDate, formatUtcDateTime } from "@/lib/format-dates"

import { PAGE_SIZE, type PostingQuery, type PostingSort } from "./posting-query"
import { postingSource, type PostingSource } from "./posting-source"

/**
 * One page of the Postings table.
 *
 * **Nothing here imports Next**, and the client arrives as an argument rather
 * than through `getPrisma()`: which rows a user can reach, and what a page past
 * the end does, are behaviours a page component cannot be tested for.
 *
 * Reads the `postings` table, which accumulates — every advertisement any of the
 * user's briefings has ever found, once each, carrying the status the user set.
 */

/**
 * One Posting, flattened to what the table renders.
 *
 * ⚠️ **`summary`, `matchReason` and `highlights` are deliberately not here.**
 * They are the largest fields a Posting has and at most one row is expanded at a
 * time, so carrying them for all twenty-five put a page of unread prose into the
 * RSC payload of every sort click. `load-posting-detail.ts` supplies them when a
 * row is opened.
 */
export interface PostingView {
  /**
   * The derived Posting id — sixteen hex characters — which is the row's
   * identity together with the user, the React key, and the last segment of a
   * cover letter's storage key. Never `postings.id`.
   */
  id: string
  title: string
  company: string
  location: string
  url: string
  status: PostingStatus
  /**
   * What the Posted cell shows: `postings.posted_at` formatted, or — when that
   * is NULL because the write path could not read the stated date — the
   * advertisement's own words. Absent only when it said nothing at all.
   *
   * ⚠️ **The fallback is not a mistake.** A row that says "3 days ago" keeps
   * saying it rather than degrading to an em-dash; NULLs order last in both
   * directions, and a phrase is visibly not a date, so the value on screen and
   * the order it sits in cannot appear to contradict each other. See
   * {@link toView}.
   */
  postedAt?: string
  /**
   * Which job board this came from, derived from {@link PostingView.url} rather
   * than stored — see `posting-source.ts` for why there is no column.
   *
   * Absent only when the stored URL will not parse; a host no board claims still
   * answers, with the hostname.
   */
  source?: PostingSource
  /**
   * How well this advertisement matches the user's resume, 0–100.
   *
   * Absent until the scoring loop on this page reaches it — see
   * `components/jobs/postings/score-pending-matches.tsx`. Absent is a state the
   * column renders rather than a fault: an unscored Posting is not a
   * badly-matched one, and the order puts it last either way.
   *
   * ⚠️ **The number and nothing else.** The reason behind it and the gaps it
   * names arrive with `load-posting-detail.ts` when a row is opened — they are
   * prose, and the split exists to stop twenty-five rows carrying them.
   */
  matchScore?: number
  /**
   * How long ago this advertisement was first found, as "3 weeks ago".
   *
   * Relative because the question the detail panel is asked is *is this stale*,
   * and a UTC stamp makes the reader do the subtraction. {@link firstSeenExact}
   * carries the stamp for the `title` attribute.
   */
  firstSeen: string
  /** The same instant, formatted, UTC, with the zone named. */
  firstSeenExact: string
  /** How long ago it was most recently re-found. See {@link firstSeen}. */
  lastSeen: string
  /** The same instant, formatted, UTC, with the zone named. */
  lastSeenExact: string
  /**
   * The name of the Briefing that most recently found this advertisement —
   * `lastSeenRun.job.name`, read through the relation.
   *
   * A plain string because it crosses into a client component. **This table is
   * cumulative across every Briefing a user has**, so without it someone with
   * three of them cannot tell which one surfaced a given row.
   *
   * Never empty: a relation that could not name one degrades to
   * {@link UNKNOWN_BRIEFING} rather than costing the row. See
   * {@link briefingName}.
   */
  briefing: string
}

/**
 * ⚠️ **`lastSeenRunId` is deliberately not on {@link PostingView}**, though
 * {@link PostingView.briefing} is resolved through that column. Nothing rendered
 * needs the *id* — drafting reads `postings.payload` and takes the run id off the
 * row server-side — so carrying it out to a client component would put an
 * identifier on the wire that nothing sends back. The *name* is the label a
 * person reads, so it is resolved here instead.
 */

export interface PostingPage {
  postings: PostingView[]
  /**
   * Every Posting this user has *that their filters admit*, not the length of
   * {@link postings}.
   */
  total: number
  /**
   * How many of this user's Postings their title filters removed.
   *
   * ⚠️ **The page is expected to say this out loud.** A filter that quietly
   * shrinks a table is indistinguishable from briefings that stopped finding
   * anything, so the count is the only thing standing between a working filter
   * and a bug report. `0` when nothing is filtered.
   */
  hidden: number
  /** The page actually rendered, which is not always the one asked for. */
  page: number
  pageCount: number
  pageSize: number
}

/**
 * One page of this user's Postings, as the table renders it.
 *
 * ⚠️ **The query is `listPostingPage` in `@workspace/db`, and everything about
 * *reading* a page belongs to it** — the `userId` scoping that is the ownership
 * check rather than a filter in front of one, the count, the clamp against the
 * real page count, the `postingId` tie-break that stops a row appearing on two
 * pages, NULLS LAST on `postedAt`. The reasoning sits next to the SQL, and
 * `stores.test.ts` exercises it against a real Postgres — those are properties
 * of an index and a planner, which a hand-written fake could only agree with.
 *
 * What stays here is what the database has no opinion about: mapping the URL's
 * sort vocabulary onto the column vocabulary, parsing `payload` against a schema
 * `@workspace/db` deliberately cannot see, formatting every instant on the
 * server, and deciding what a row that answered nothing degrades to.
 *
 * ⚠️ **Two clamps, two owners.** `MAX_PAGE` in `posting-query.ts` bounds the
 * app's first untrusted GET input before anything has been counted; the clamp
 * against the *real* page count is the query's. Neither stands in for the other.
 */
export async function listPostings(
  prisma: PrismaClient,
  userId: string,
  query: PostingQuery
): Promise<PostingPage> {
  // ⚠️ **Serial, and it has to be**: the patterns are an argument to the page
  // query. One indexed primary-key lookup, and caching it across requests would
  // mean a save that does not take effect until something expires.
  //
  // ⚠️ **Words become patterns here, and only here.** `@workspace/db` is handed
  // `" senior "` rather than `"senior"` because it filters and does not
  // interpret: what a user's word *means* is `@workspace/job-search`'s, and the
  // package that owns the SQL must not have a second opinion about it.
  const excludeTitlePatterns = (await titleExclusions(prisma, userId)).map(
    titleMatchPattern
  )

  const { rows, total, hidden, page, pageCount } = await listPostingPage(
    prisma,
    userId,
    {
      order: ORDER_FOR[query.sort],
      direction: query.direction,
      page: query.page,
      pageSize: PAGE_SIZE,
      excludeTitlePatterns,
    }
  )

  // One instant for the whole page, so twenty-five sightings a few milliseconds
  // apart cannot be described relative to twenty-five slightly different "now"s.
  const now = new Date()

  let unreadable = 0
  let unnamed = 0
  const postings = rows.map((row) => {
    // ⚠️ **Parsed here and handed down, rather than asked of the view
    // afterwards.** The count used to be `view.summary === undefined`, which
    // broke when `summary` moved to `load-posting-detail.ts`. One parse, in one
    // place, keeps the reporting honest.
    const parsed = StoredPostingSchema.safeParse(row.payload)

    if (!parsed.success) unreadable += 1
    // Only a row a Run *should* have named counts as unnamed. A Posting the
    // user added by link has no Briefing behind it by construction, and
    // reporting one as a fault would bury a real relation failure in noise.
    if (!row.addedByLink && briefingName(row.briefing) === undefined) {
      unnamed += 1
    }

    return toView(row, parsed, now)
  })

  if (unreadable > 0) {
    // Once per page rather than once per row: a payload the schema stopped
    // matching is contract drift, and the rows still render from their projected
    // columns — so without this line the drift is invisible until someone opens
    // one and is told the detail could not be read.
    console.error(
      "postings: could not read the stored payload for",
      unreadable,
      "of",
      rows.length,
      "rows"
    )
  }

  if (unnamed > 0) {
    // Reported separately from the payload count: that is stored JSON drifting
    // from the schema, this is the relation itself answering nothing. Different
    // causes, so a single line covering both would name neither.
    console.error(
      "postings: could not read which briefing last found",
      unnamed,
      "of",
      rows.length,
      "rows"
    )
  }

  return { postings, total, hidden, page, pageCount, pageSize: PAGE_SIZE }
}

/**
 * The URL's sort vocabulary, mapped onto the column vocabulary.
 *
 * ⚠️ **Two enums, and the mapping between them is the point.**
 * `POSTING_SORTS` in `posting-query.ts` is how a *URL* spells a sort;
 * `PostingOrder` in `@workspace/db` is what the query orders by. Keeping them
 * separate stops an address bar from naming a database column — two of the four
 * differ in spelling for exactly that reason.
 *
 * A `satisfies`-checked record rather than a switch, so a sort added to either
 * enum without the other fails to compile.
 */
const ORDER_FOR = {
  lastSeen: "lastSeenAt",
  title: "title",
  company: "company",
  posted: "postedAt",
  match: "match",
} as const satisfies Record<PostingSort, PostingOrder>

/**
 * A row as the table renders it.
 *
 * ⚠️ **An unreadable `payload` degrades to the projected columns rather than
 * dropping the row.** `title`, `company`, `location` and `url` are real columns
 * written by the same statement that wrote the payload, so drift costs the
 * detail and not the advertisement itself. Dropping the row would make contract
 * drift look like a Posting nobody ever found.
 *
 * `parsed` arrives as an argument because the caller counts the failures for its
 * once-per-page report and neither should pay for the parse twice.
 *
 * Every `Date` becomes a string here, on the server: a `Date` crossing into a
 * client component is formatted with the browser's locale and timezone, and
 * React reports the disagreement as a hydration mismatch rather than as the
 * timezone bug it is.
 */
function toView(
  row: PostingListRow,
  parsed: ReturnType<typeof StoredPostingSchema.safeParse>,
  now: Date
): PostingView {
  // Independent of the parse, deliberately: `url` is a projected column, so a
  // Posting whose payload the schema no longer matches still knows which board
  // it came from.
  const source = postingSource(row.url)

  return {
    id: row.postingId,
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    status: toStatus(row.status),
    ...(source ? { source } : {}),
    // Nullish rather than `=== null`, for the reason `toMatchRow` in
    // `@workspace/db` gives: a client that answered less than it was asked would
    // put `matchScore: undefined` on the view, which the cell renders as a blank
    // rather than as the absent score it is.
    ...(row.matchScore == null ? {} : { matchScore: row.matchScore }),
    firstSeen: formatSeenAgo(row.firstSeenAt, now),
    firstSeenExact: formatUtcDateTime(row.firstSeenAt),
    lastSeen: formatSeenAgo(row.lastSeenAt, now),
    lastSeenExact: formatUtcDateTime(row.lastSeenAt),
    briefing:
      briefingName(row.briefing) ??
      (row.addedByLink ? ADDED_BY_LINK : UNKNOWN_BRIEFING),
    // The column when the write path could read a date, the advertisement's own
    // words when it could not, nothing when it said nothing — see
    // {@link PostingView.postedAt} for why the second case is kept.
    //
    // No time and no zone name, unlike {@link formatUtcDateTime}: any time of day
    // here is an artefact of the ISO string, and "00:00 UTC" beside every row
    // would be precision the value does not have.
    ...(row.postedAt
      ? { postedAt: formatCalendarDate(row.postedAt) }
      : parsed.success && parsed.data.postedAt
        ? { postedAt: parsed.data.postedAt }
        : {}),
  }
}

/** What the dialog shows when the relation could not name a Briefing. */
const UNKNOWN_BRIEFING = "Unknown briefing"

/**
 * What it shows instead when there was never a Briefing to name.
 *
 * ⚠️ **Distinct from {@link UNKNOWN_BRIEFING}, which is why `addedByLink` is
 * carried out of `@workspace/db`.** Both are a `null` briefing; one is the user's
 * own paste and the other is a fault, and one word for both would tell somebody
 * their paste had lost its provenance.
 */
const ADDED_BY_LINK = "Added by link"

/**
 * The Briefing's name as the row carries it, or `undefined` when it has none.
 *
 * ⚠️ **A display rule, which is why it stayed here** when the relation walk
 * moved into `listPostingPage`. That function flattens `lastSeenRun.job.name` to
 * `string | null` and stops there; **blank counting as no answer is this side's
 * judgement** — `jobs.name` has no emptiness constraint, and an empty string
 * renders as a missing value rather than as one.
 *
 * Deliberately pure — no logging — because {@link listPostings} reports these
 * once per page and needs this same rule to count them. The caller degrades to
 * {@link UNKNOWN_BRIEFING} rather than dropping the row: losing the label must
 * not look like a Posting nobody ever found.
 */
function briefingName(briefing: string | null): string | undefined {
  return briefing === null || briefing === "" ? undefined : briefing
}

/**
 * The stored status, narrowed to the four the app knows.
 *
 * `postings_status_check` makes a fifth value impossible, so this is not defence
 * against the database — it is the branch that fires when a fifth status reaches
 * the schema before the deployment that knows the word. That window is real and
 * was widened by `not-interested`: a migration reaches production on merge to
 * `main`, and the deployment lands separately. `new` is the honest fallback.
 */
function toStatus(status: string): PostingStatus {
  const known = POSTING_STATUSES.find((candidate) => candidate === status)

  if (known === undefined) {
    console.error("postings: unrecognised status", status)
    return "new"
  }

  return known
}

/**
 * The largest unit worth describing a gap in, longest first.
 *
 * Each entry is one of that unit in milliseconds; the first smaller than the gap
 * wins. Months and years are the usual approximate lengths, which is the right
 * kind of wrong for "2 months ago" — {@link PostingView.lastSeenExact} carries
 * the real instant.
 */
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
]

/**
 * `numeric: "auto"` is what produces "yesterday" and "today" in place of
 * "1 day ago" and "0 days ago", which is the whole reason to use
 * `RelativeTimeFormat` rather than assembling the string by hand.
 */
const RELATIVE_FORMAT = new Intl.RelativeTimeFormat("en-AU", {
  numeric: "auto",
})

/**
 * A sighting as "3 weeks ago", relative to a caller-supplied instant.
 *
 * ⚠️ **`now` is an argument and not `new Date()`.** A function that reads the
 * clock cannot be asserted against, and {@link listPostings} wants one instant
 * for a whole page besides.
 *
 * A future date formats as "in 3 weeks" rather than being clamped. It should not
 * happen, but clock skew between the worker and the web host is real, and
 * rendering a future sighting as "just now" would hide it.
 */
export function formatSeenAgo(date: Date, now: Date): string {
  const elapsed = date.getTime() - now.getTime()
  const magnitude = Math.abs(elapsed)

  // Never empty, and the last entry is the fallback: anything under a second
  // rounds to "now" through the `second` unit.
  const [unit, size] = RELATIVE_UNITS.find(
    ([, length]) => magnitude >= length
  ) ?? ["second", 1000]

  return RELATIVE_FORMAT.format(Math.round(elapsed / size), unit)
}
