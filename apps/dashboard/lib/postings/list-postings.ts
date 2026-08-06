import { PostingSchema } from "@workspace/agents/findings"
import {
  POSTING_STATUSES,
  type PostingStatus,
  type PrismaClient,
} from "@workspace/db"

import { formatCalendarDate } from "@/lib/format-calendar-date"
import { formatUtcDateTime } from "@/lib/format-utc-datetime"

import { PAGE_SIZE, type PostingQuery } from "./posting-query"
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
  /** Every Posting this user has, not the length of {@link postings}. */
  total: number
  /** The page actually rendered, which is not always the one asked for. */
  page: number
  pageCount: number
  pageSize: number
}

/**
 * One page of this user's Postings, in the order the query asks for.
 *
 * ⚠️ **`where: { userId }` is the whole of the row scoping, and it is not
 * optional.** The page guard establishes *who is asking*; it says nothing about
 * which rows they may read. A Posting is not addressable without naming a user
 * — `(user_id, posting_id)` is the natural key — so this filter is the check
 * rather than a shortcut past one, and `list-postings.test.ts` asserts against a
 * second user's rows.
 *
 * ⚠️ **The count and the page are asked for together, and the re-fetch below is
 * what keeps that safe.** `?page=99` on a three-page table must render the last
 * page, not an empty one with working controls underneath it — so the page
 * still has to be clamped against a total only the count knows. Doing that in
 * order meant two serial round trips on *every* render to pay for a case that
 * almost never happens. Asking for both at once and re-fetching only when the
 * requested page really did overshoot costs one round trip in the common case
 * and the original two in the rare one. The clamp itself is unchanged, and
 * `list-postings.test.ts` asserts it from the outside.
 *
 * The price is a query that is sometimes wasted: an empty table and an
 * overshooting page both issue a fetch whose result is discarded. Neither costs
 * wall-clock, because it ran alongside the count either way — and an empty
 * table is the cheapest query this schema has.
 *
 * ⚠️ **A hand-typed `?page=9999` now reaches `skip` before the clamp, and that
 * is survivable rather than an oversight.** `OFFSET` can only discard rows that
 * exist, so the work is bounded by how many Postings the *user* has and not by
 * the number they typed — a huge offset over a small table scans the same index
 * entries and returns nothing. `MAX_PAGE` in `posting-query.ts` is still what
 * keeps the value finite, and it is now the only bound in front of this query
 * rather than the outer of two.
 *
 * ⚠️ **`orderBy` is tie-broken on `postingId`, and that is a correctness fix,
 * not a nicety.** Offset pagination over a non-unique key — every sort here but
 * the dates is non-unique, and two Runs in one slot can share a `last_seen_at`
 * too — lets the database choose freely among equal rows, so the same row can
 * appear on page 1 and page 2 while another appears on neither. The tie-break
 * is in the same direction as the sort so that the default order stays a scan
 * of `postings_user_last_seen_idx`, which carries `(last_seen_at DESC,
 * posting_id DESC)`.
 *
 * **Text ordering follows the database's collation.** Neon's default sorts
 * naturally; a `C`-collation database would put every uppercase title before
 * every lowercase one. One line to know about rather than something to work
 * around in the query.
 */
export async function listPostings(
  prisma: PrismaClient,
  userId: string,
  query: PostingQuery
): Promise<PostingPage> {
  const [total, requested] = await Promise.all([
    prisma.posting.count({ where: { userId } }),
    findPage(prisma, userId, query, query.page),
  ])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (total === 0) {
    return { postings: [], total, page: 1, pageCount, pageSize: PAGE_SIZE }
  }

  const page = Math.min(query.page, pageCount)

  // The speculative fetch was for the page that was asked for. When that was
  // past the end it returned nothing and is discarded, and the clamped page is
  // fetched properly — the only path that still pays two round trips.
  const rows =
    page === query.page
      ? requested
      : await findPage(prisma, userId, query, page)

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
    const parsed = PostingSchema.safeParse(row.payload)

    if (!parsed.success) unreadable += 1
    if (briefingName(row.lastSeenRun) === undefined) unnamed += 1

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

  return { postings, total, page, pageCount, pageSize: PAGE_SIZE }
}

/**
 * One slice of `postings`, in the order the query asks for.
 *
 * Split out of {@link listPostings} because it is now issued from two places —
 * speculatively for the page that was asked for, and again for the clamped page
 * when that overshot. The projection has to be identical in both, which is what
 * having one function guarantees.
 *
 * `page` is a parameter rather than being read off `query`, precisely because
 * the two disagree in the case this exists to serve.
 */
function findPage(
  prisma: PrismaClient,
  userId: string,
  query: PostingQuery,
  page: number
) {
  return prisma.posting.findMany({
    where: { userId },
    orderBy: orderByFor(query),
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      postingId: true,
      title: true,
      company: true,
      location: true,
      url: true,
      status: true,
      postedAt: true,
      payload: true,
      firstSeenAt: true,
      lastSeenAt: true,
      // Which Briefing found it, asked for with the page rather than resolved
      // row by row afterwards: `postings.last_seen_run_id` → `runs.job_id` →
      // `jobs.name`. **`lastSeenRun`, not `firstSeenRun`** — the Briefing that
      // most recently found the advertisement is the one whose criteria still
      // match it, and it is the sighting the default sort orders on.
      lastSeenRun: { select: { job: { select: { name: true } } } },
    },
  })
}

/**
 * The order one page is read in, written out per column rather than built from
 * a computed key.
 *
 * The query string never names a database column: `sort=title` selects a branch
 * here, so the set of orderable fields is this function and not "whatever
 * `postings` happens to have". A `{ [field]: direction }` object would be the
 * same handful of lines with the column name arriving as a string, which is both
 * untypeable against Prisma's input and a shape a reader has to check by hand.
 *
 * **Every branch carries the `postingId` tie-break, in the same direction.**
 * See {@link listPostings} for why a page boundary without it shows one row
 * twice and skips another.
 *
 * ⚠️ **`posted` is NULLS LAST in *both* directions, and that asymmetry is the
 * point.** It is the one nullable column here, and NULL does not mean "long
 * ago": it means the advertisement did not state a date, or stated one the
 * write path would not read as a date. Postgres would default to NULLS FIRST
 * under `DESC`, which puts every row that says nothing above every row that
 * says something — the opposite of what someone clicking "Posted" is asking
 * for. Sorting ascending does not make those rows interesting either, so they
 * stay at the bottom whichever way the column runs.
 */
function orderByFor(query: PostingQuery) {
  const to = query.direction

  switch (query.sort) {
    case "lastSeen":
      return [{ lastSeenAt: to }, { postingId: to }]

    case "title":
      return [{ title: to }, { postingId: to }]

    case "company":
      return [{ company: to }, { postingId: to }]

    case "posted":
      // `as const` so `nulls` narrows to `Prisma.NullsOrder` rather than
      // widening to `string`, which the generated input type refuses.
      return [
        { postedAt: { sort: to, nulls: "last" as const } },
        { postingId: to },
      ]
  }
}

/** The columns this module reads off a `postings` row, and all it reads. */
interface PostingRow {
  postingId: string
  title: string
  company: string
  location: string
  url: string
  status: string
  /** NULL when the advertisement stated no date, or stated a non-date. */
  postedAt: Date | null
  payload: unknown
  firstSeenAt: Date
  lastSeenAt: Date
  /**
   * The Briefing that most recently found this Posting, as the nested `select`
   * asks for it.
   *
   * ⚠️ **Both halves are typed nullable although neither relation is optional
   * in the schema.** `postings.last_seen_run_id` and `runs.job_id` are NOT NULL
   * with `onDelete: Restrict`, so Postgres cannot answer with a hole — the
   * nullability is not a claim about the database. It is what keeps a client
   * that answered *less* than it was asked from taking the whole page down with
   * a `TypeError` on `.job`: the `DEV_AUTH_BYPASS` fake did exactly that until
   * it learned to apply `select`, and a future caller narrowing the projection
   * would do it again.
   */
  lastSeenRun: { job: { name: string } | null } | null
}

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
  row: PostingRow,
  parsed: ReturnType<typeof PostingSchema.safeParse>,
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
    firstSeen: formatSeenAgo(row.firstSeenAt, now),
    firstSeenExact: formatUtcDateTime(row.firstSeenAt),
    lastSeen: formatSeenAgo(row.lastSeenAt, now),
    lastSeenExact: formatUtcDateTime(row.lastSeenAt),
    briefing: briefingName(row.lastSeenRun) ?? UNKNOWN_BRIEFING,
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
 * The Briefing's name as the relation answered, or `undefined` when it did not.
 *
 * Deliberately pure — no logging — because {@link listPostings} reports these
 * once per page rather than once per row, and it needs this same rule to count
 * them. Blank counts as no answer: `jobs.name` has no emptiness constraint, and
 * an empty string renders as a missing value rather than as one.
 *
 * ⚠️ **The caller degrades rather than drops.** The row keeps its place with
 * {@link UNKNOWN_BRIEFING} in place of the name, for the reason {@link toView}
 * gives about an unreadable payload: which Briefing found an advertisement is
 * provenance, and the advertisement is what the user came for. Losing the label
 * must not look like a Posting nobody ever found.
 */
function briefingName(
  lastSeenRun: PostingRow["lastSeenRun"]
): string | undefined {
  const name = lastSeenRun?.job?.name

  return name === undefined || name === "" ? undefined : name
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
