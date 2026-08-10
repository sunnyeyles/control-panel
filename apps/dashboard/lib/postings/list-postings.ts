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
 * **Nothing here imports Next**, for the reason `lib/jobs/job-actions.ts` gives:
 * which rows a user can reach, and what a page past the end does, are exactly
 * the behaviours a page component cannot be tested for. The client arrives as
 * an argument rather than through `getPrisma()` for the same reason.
 *
 * This replaced `lib/briefings/latest-postings.ts`, and the difference is the
 * whole feature: that module read one Run's `findings` and a Posting the next
 * Run did not re-find simply vanished. This reads the `postings` table, which
 * accumulates — every advertisement any of the user's briefings has ever found,
 * once each, carrying the status the user set.
 */

/**
 * One Posting, flattened to what the table renders.
 *
 * ⚠️ **`summary`, `matchReason` and `highlights` are deliberately not here.**
 * They are the expanded row's content, they are the largest fields a Posting
 * has, and at most one row is expanded at a time — so carrying them for all
 * twenty-five put roughly a page's worth of prose nobody was reading into the
 * RSC payload of every sort click. They now come from
 * `load-posting-detail.ts` when a row is actually opened. Everything below is
 * what the compact row, the delete dialog and the letter controls read, and it
 * is all short.
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
   * What the Posted cell shows: the parsed `postings.posted_at` formatted, or —
   * when that is NULL because the advertisement stated a date the write path
   * would not read as one — the advertisement's own words, verbatim.
   *
   * Absent only when it said nothing at all.
   *
   * ⚠️ **The two cases are deliberately one field, and the fallback is not a
   * mistake.** A row that says "3 days ago" keeps saying it rather than
   * degrading to an em-dash, and the column orders NULLs last so such a row sits
   * at the bottom under either direction. A phrase is visibly not a date, so the
   * value on screen and the order it sits in cannot appear to contradict each
   * other. See {@link toView}.
   */
  postedAt?: string
  /**
   * Which job board this came from, derived from {@link PostingView.url} rather
   * than stored — see `posting-source.ts` for why there is no column.
   *
   * Absent only when the stored URL will not parse, which is a different thing
   * from a host no board claims: that still answers, with the hostname.
   */
  source?: PostingSource
  /**
   * How well this advertisement matches the user's resume, 0–100.
   *
   * Absent when nobody has scored it yet, which is every Posting until the
   * scoring loop on this page reaches it — see
   * `components/jobs/postings/score-pending-matches.tsx`. Absent is a state the
   * column renders rather than a fault: an unscored Posting is not a
   * badly-matched one, and the order puts it last either way.
   *
   * ⚠️ **The number and nothing else.** The reason behind it and the gaps it
   * names arrive with `load-posting-detail.ts` when a row is opened, for the
   * reason the docblock above gives about `summary`: they are prose, and
   * carrying them for twenty-five rows to serve the one that gets expanded is
   * what that split exists to stop.
   */
  matchScore?: number
  /**
   * How long ago this advertisement was first found, as "3 weeks ago".
   *
   * Relative rather than absolute because the question the detail panel is
   * asked is *is this stale*, and a UTC stamp makes the reader do the
   * subtraction. {@link firstSeenExact} is the stamp, carried alongside for the
   * `title` attribute rather than instead of this.
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
   * A plain string, like every other field here, because it crosses into a
   * client component and the dialog renders it verbatim. **This table is
   * cumulative across every Briefing a user has**, so without it someone with
   * three of them cannot tell which one surfaced a given row — the superseded
   * Posting card got that for free from the heading of the card it sat in.
   *
   * Never empty: a relation that could not name one degrades to
   * {@link UNKNOWN_BRIEFING} rather than costing the row. See
   * {@link briefingName}.
   */
  briefing: string
}

/**
 * ⚠️ **`lastSeenRunId` is deliberately not on {@link PostingView}, even though
 * {@link PostingView.briefing} is resolved through that very column.** The
 * column is real provenance, but nothing this page renders needs the *id*: its
 * only reader was `DraftCoverLetterButton`, back when drafting re-read the
 * Posting out of `runs.findings` and had to name a Run. It reads
 * `postings.payload` now — and reads the run id off the row itself, server-side,
 * to record on the letter — so carrying the value out to a client component
 * would put an identifier on the wire that nothing sends back. The Briefing's
 * *name* is the opposite kind of thing: it is the label a person reads, so it is
 * resolved here and no client is ever handed a run id to make sense of.
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
   * anything, and the row is not there to be noticed — so the count is the only
   * thing standing between a working filter and a bug report. `0` when nothing
   * is filtered, which is the usual case.
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
 * check rather than a filter in front of one, the count issued alongside the
 * page, the clamp against the real page count and the re-fetch when a requested
 * page overshot, the `postingId` tie-break that stops a row appearing on two
 * pages, and NULLS LAST on `postedAt` in both directions. The reasoning for each
 * is there, next to the SQL it is about, and `stores.test.ts` exercises it
 * against a real Postgres — which is the point: those are properties of an index
 * and a planner, and a hand-written fake could only agree with whoever wrote it.
 *
 * What stays here is everything the database has no opinion about: mapping the
 * URL's sort vocabulary onto the column vocabulary, parsing `payload` against a
 * schema `@workspace/db` deliberately cannot see, formatting every instant on
 * the server, and deciding what a row that answered nothing degrades to.
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
  // query, so there is nothing to overlap it with. One indexed primary-key
  // lookup, and the alternative — caching it across requests — would mean a
  // save that does not take effect until something expires.
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

  // One instant for the whole page, read once rather than per row, so twenty-five
  // sightings a few milliseconds apart cannot be described relative to twenty-five
  // slightly different "now"s.
  const now = new Date()

  let unreadable = 0
  let unnamed = 0
  const postings = rows.map((row) => {
    // ⚠️ **Parsed here and handed down, rather than asked of the view
    // afterwards.** The count used to be `view.summary === undefined`, which
    // worked only while `summary` came from the payload and lived on
    // `PostingView`; it comes from `load-posting-detail.ts` now. Doing the
    // parse in this one place keeps the reporting honest without parsing every
    // payload twice.
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
    // matching is a contract drift, and one line naming how many rows it hit is
    // the signal. The rows still render — from their projected columns — so
    // without this line the drift is invisible until someone opens one of them
    // and is told the detail could not be read.
    console.error(
      "postings: could not read the stored payload for",
      unreadable,
      "of",
      rows.length,
      "rows"
    )
  }

  if (unnamed > 0) {
    // Counted once per page for the reason above, and reported separately: an
    // unreadable payload is the stored JSON drifting from the schema, while
    // this is the relation itself answering nothing — a `select` that stopped
    // asking for it, or a fake database that ignored the one it was handed.
    // Different causes, so a single line covering both would name neither.
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
 * separate is what stops an address bar from naming a database column — a value
 * arriving from outside has to survive this table, rather than being handed to
 * the query because it happened to parse. Two of the four differ in spelling for
 * exactly that reason.
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
 * written by the same statement that wrote the payload, so a payload the
 * schema no longer matches costs the detail — the summary, the highlights, the
 * match reason — and not the advertisement itself. Dropping the row would make
 * a contract drift look like a Posting nobody ever found.
 *
 * `parsed` arrives as an argument rather than being computed here, because the
 * caller counts the failures for its once-per-page report and neither of them
 * should pay for the parse twice. The payload is read for exactly one field
 * now — see `postedAt` below.
 *
 * Every `Date` becomes a string here, on the server. A `Date` crossing into a
 * client component is formatted with the browser's locale and timezone, and
 * React reports the disagreement as a hydration mismatch rather than as the
 * timezone bug it is — the same boundary `components/documents/document-list.tsx`
 * describes.
 */
function toView(
  row: PostingListRow,
  parsed: ReturnType<typeof StoredPostingSchema.safeParse>,
  now: Date
): PostingView {
  // Independent of the parse, deliberately: `url` is a projected column
  // written by the same statement as the payload, so a Posting whose payload
  // the schema no longer matches still knows which board it came from.
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
    // `@workspace/db` gives: a client that answered less than it was asked
    // would otherwise put `matchScore: undefined` on the view, which the cell
    // renders as a blank rather than as the absent score it is.
    ...(row.matchScore == null ? {} : { matchScore: row.matchScore }),
    firstSeen: formatSeenAgo(row.firstSeenAt, now),
    firstSeenExact: formatUtcDateTime(row.firstSeenAt),
    lastSeen: formatSeenAgo(row.lastSeenAt, now),
    lastSeenExact: formatUtcDateTime(row.lastSeenAt),
    briefing:
      briefingName(row.briefing) ??
      (row.addedByLink ? ADDED_BY_LINK : UNKNOWN_BRIEFING),
    // The column when the write path could read a date out of the
    // advertisement, the advertisement's own words when it could not, and
    // nothing when it said nothing. See {@link PostingView.postedAt} for why
    // the second case is kept rather than blanked.
    //
    // No time and no zone name, unlike {@link formatUtcDateTime}: the source is a
    // date the advertisement stated, so any time of day in it is an artefact
    // of the ISO string rather than something the page said, and printing
    // "00:00 UTC" beside every row would be precision the value does not have.
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
 * ⚠️ **Distinct from {@link UNKNOWN_BRIEFING}, and the distinction is the whole
 * reason `addedByLink` is carried out of `@workspace/db`.** Both are a `null`
 * briefing; one is a Posting the user added themselves and the other is a fault.
 * Rendering them the same word would tell somebody their own paste had lost its
 * provenance.
 */
const ADDED_BY_LINK = "Added by link"

/**
 * The Briefing's name as the row carries it, or `undefined` when it has none.
 *
 * ⚠️ **A display rule, which is why it stayed here** when the relation walk
 * moved into `listPostingPage`. That function flattens `lastSeenRun.job.name`
 * to `string | null` and stops there; **blank counting as no answer is this
 * side's judgement** — `jobs.name` has no emptiness constraint, and an empty
 * string renders as a missing value rather than as one. A database has no view
 * about that.
 *
 * Deliberately pure — no logging — because {@link listPostings} reports these
 * once per page rather than once per row, and it needs this same rule to count
 * them.
 *
 * ⚠️ **The caller degrades rather than drops.** The row keeps its place with
 * {@link UNKNOWN_BRIEFING} in place of the name, for the reason {@link toView}
 * gives about an unreadable payload: which Briefing found an advertisement is
 * provenance, and the advertisement is what the user came for. Losing the label
 * must not look like a Posting nobody ever found.
 */
function briefingName(briefing: string | null): string | undefined {
  return briefing === null || briefing === "" ? undefined : briefing
}

/**
 * The stored status, narrowed to the three the app knows.
 *
 * `postings_status_check` makes a fourth value impossible, so this is not a
 * defensive branch against the database — it is the branch that fires if a
 * fourth status is ever added to the schema and this app is deployed before the
 * label map catches up. `new` is the honest fallback: it is what a Posting
 * nobody has touched is, and the alternative is an empty cell.
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
 * Each entry is the length of one of that unit in milliseconds; the first whose
 * unit is smaller than the gap wins. Months and years are the usual approximate
 * lengths, which is the right kind of wrong for a phrase like "2 months ago" —
 * the reader is being told an order of magnitude, and
 * {@link PostingView.lastSeenExact} carries the real instant for anyone who
 * needs it.
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
 * clock cannot be asserted against — every expectation would have to be written
 * relative to the moment the test happened to run — and {@link listPostings}
 * wants one instant for a whole page besides. This is the same reason
 * `lib/briefing-runs/` takes its clock as a parameter.
 *
 * A future date formats as "in 3 weeks" rather than being clamped. It should not
 * happen — both columns are written by a Run that has already finished — but a
 * clock skew between the worker and the web host is a real thing, and silently
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
