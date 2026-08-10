import { Prisma, type PrismaClient } from "./generated/prisma/client.ts"
import type { PostingPayload, PostingStatus } from "./types.ts"

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * The three statuses, as a value.
 *
 * Lives here rather than in `types.ts`, which is type-only and erases: a
 * runtime array there would make that module emit, and every consumer that
 * imports a type from it would start pulling in a value.
 *
 * `satisfies` rather than a hand-kept copy, so adding a status to
 * {@link PostingStatus} without adding it here fails to compile.
 */
export const POSTING_STATUSES = [
  "new",
  "applied",
  "rejected",
] as const satisfies readonly PostingStatus[]

/**
 * A Posting on its way in, as whatever found it describes it.
 *
 * Deliberately opaque to this package: `postingId` is derived by `postingId()`
 * in `@workspace/agents` and `payload` is that package's validated Posting, but
 * neither type is imported here. `@workspace/db` must not depend on the agent
 * stack — the one place the two meet is the worker's own `toNewPostings`.
 */
export interface NewPosting {
  /**
   * The derived Posting id: sixteen lowercase hex characters, which a CHECK on
   * the column enforces because the value is also an S3 key segment.
   */
  postingId: string
  title: string
  company: string
  location: string
  url: string
  /**
   * When the advertisement said the role was posted, parsed.
   *
   * Absent when it said nothing and absent when what it said is not a date —
   * the producer decides which, and this package does not know the rule. It is
   * a `Date` rather than the string the payload carries precisely so that it
   * cannot be: a column the table orders by has to be a point in time before it
   * gets here.
   */
  postedAt?: Date
  payload: PostingPayload
}

/** One Run's sighting of some Postings. */
export interface SeenPostings {
  userId: string
  /**
   * The Run that reported them — provenance, and not part of the identity.
   * Written to `first_seen_run_id` on the first sighting and to
   * `last_seen_run_id` on every one that is not older than the last.
   */
  runId: string
  /**
   * When they were found. The caller supplies it rather than the database
   * defaulting to `now()`, because the two callers mean different instants:
   * the worker passes the Run's *slot*, and the backfill passes each historic
   * Run's `started_at` so `first_seen_at` means "when this advertisement first
   * appeared" rather than "when the backfill ran".
   */
  seenAt: Date
  postings: NewPosting[]
}

/**
 * Record what a Run found, as one statement, without ever touching a status.
 *
 * Returns how many rows were inserted or updated, which is not always
 * `postings.length`: a sighting older than the one already recorded matches the
 * `WHERE` below, changes nothing, and is not counted.
 *
 * ⚠️ **Four things about the `DO UPDATE SET` list below are load-bearing, and
 * every one of them is silently undoable.**
 *
 * 1. **`status` is absent, and that absence is the feature.** It is the only
 *    column in this schema a person writes. Adding `status = EXCLUDED.status`
 *    "for symmetry", or rewriting this as DELETE + INSERT, would mean a Posting
 *    marked `applied` reverts to `new` the next time a Run re-finds it —
 *    discarding the only data in this table a person entered, on a schedule,
 *    with no error and no trace.
 * 2. **`status_changed_at` is absent for the same reason.** It answers "when
 *    did the user last touch this", and a Run touching the row is not the user
 *    touching it.
 * 3. **`first_seen_at` and `first_seen_run_id` are absent too.** They answer
 *    "when did this first appear, and which Run found it" — a question a second
 *    sighting cannot change the answer to. Writing them here would make every
 *    row claim it was first seen by the most recent Run.
 * 4. **The trailing `WHERE` is what makes this write order-independent.** The
 *    backfill walks Runs oldest-first while live ticks are recording new ones;
 *    without the guard an old sighting arriving late would drag `last_seen_at`
 *    backwards and leave `last_seen_run_id` naming a Run that is not the most
 *    recent one to have seen it.
 *
 * Raw SQL rather than `prisma.posting.upsert` in a loop, per this package's
 * rule that conflict-shaped writes are helpers owning their `ON CONFLICT`
 * target — the same reason `claimJob` is raw. One statement is atomic and one
 * round trip; a read-then-write upsert would turn two overlapping ticks finding
 * the same advertisement into a unique violation.
 */
export async function recordPostings(
  prisma: DbClient,
  seen: SeenPostings
): Promise<number> {
  const postings = dedupe(seen.postings)
  if (postings.length === 0) return 0

  const rows = postings.map(
    (posting) => Prisma.sql`(
      ${seen.userId}::uuid,
      ${posting.postingId},
      ${posting.title},
      ${posting.company},
      ${posting.location},
      ${posting.url},
      ${posting.postedAt ?? null}::timestamptz,
      ${JSON.stringify(posting.payload)}::jsonb,
      ${seen.seenAt}::timestamptz,
      ${seen.seenAt}::timestamptz,
      ${seen.runId}::uuid,
      ${seen.runId}::uuid
    )`
  )

  return prisma.$executeRaw(Prisma.sql`
    INSERT INTO postings (
      user_id, posting_id, title, company, location, url, posted_at, payload,
      first_seen_at, last_seen_at, first_seen_run_id, last_seen_run_id
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (user_id, posting_id) DO UPDATE SET
      title = EXCLUDED.title,
      company = EXCLUDED.company,
      location = EXCLUDED.location,
      url = EXCLUDED.url,
      posted_at = EXCLUDED.posted_at,
      payload = EXCLUDED.payload,
      last_seen_at = EXCLUDED.last_seen_at,
      last_seen_run_id = EXCLUDED.last_seen_run_id
    WHERE EXCLUDED.last_seen_at >= postings.last_seen_at
  `)
}

/** One Posting somebody added by pasting its link. */
export interface LinkedPosting {
  userId: string
  /**
   * When they added it. Both `first_seen_at` and `last_seen_at` take it, for
   * the reason {@link SeenPostings.seenAt} gives: the caller owns the clock.
   */
  seenAt: Date
  posting: NewPosting
}

/**
 * Record a Posting no Run found. Answers whether a row was actually inserted.
 *
 * Both run columns are absent from the column list, so they take the NULL that
 * `0009` made legal — which is the whole of how a link-added Posting is
 * distinguishable from a found one. There is no `source` column.
 *
 * ⚠️ **`DO NOTHING`, and that is the entire safety argument for this function
 * existing beside {@link recordPostings} rather than as a flag on it.** A link
 * may *create* a Posting and may never *revise* one. Every way of writing an
 * update here is a way of destroying something:
 *
 * - `status` is the one column a person writes, and re-pasting a link for an
 *   advertisement already marked `applied` must not walk it back to `new`.
 * - `last_seen_run_id` records which Run most recently found it. Overwriting a
 *   Run's id with the NULL this path carries would erase provenance and make a
 *   Posting several Runs have found read as one nobody ever did.
 * - `payload` written by a Run carries a `matchReason` this path has none of, so
 *   an update would swap a fuller record for a thinner one.
 *
 * The caller checks for an existing Posting before it spends a page fetch and a
 * model call, so a duplicate paste normally never reaches this statement. What
 * this clause covers is the race the check cannot: two submissions in flight at
 * once, and a Run recording the same advertisement in between.
 *
 * A `false` return is therefore not a failure — it means the advertisement is
 * already tracked, which is an ordinary thing to tell somebody.
 */
export async function recordLinkedPosting(
  prisma: DbClient,
  linked: LinkedPosting
): Promise<boolean> {
  const { posting } = linked

  const inserted = await prisma.$executeRaw(Prisma.sql`
    INSERT INTO postings (
      user_id, posting_id, title, company, location, url, posted_at, payload,
      first_seen_at, last_seen_at
    )
    VALUES (
      ${linked.userId}::uuid,
      ${posting.postingId},
      ${posting.title},
      ${posting.company},
      ${posting.location},
      ${posting.url},
      ${posting.postedAt ?? null}::timestamptz,
      ${JSON.stringify(posting.payload)}::jsonb,
      ${linked.seenAt}::timestamptz,
      ${linked.seenAt}::timestamptz
    )
    ON CONFLICT (user_id, posting_id) DO NOTHING
  `)

  return inserted > 0
}

/** One Posting's stored payload, and the Run that most recently reported it. */
export interface StoredPostingPayload {
  /**
   * The advertisement as its producer validated it, opaque to this package.
   *
   * The caller parses it. `@workspace/db` must not depend on the agent stack, so
   * the schema that would say whether this is still readable lives on the other
   * side of the seam — which is why both callers own a "the stored payload no
   * longer parses" branch rather than being handed one.
   */
  payload: PostingPayload
  /**
   * `last_seen_run_id`: provenance, and no part of the identity.
   *
   * `null` for a Posting the user added by pasting its link, which no Run has
   * ever seen. Callers that stamp provenance onto something they generate — a
   * cover letter, a tailored resume — leave the field off rather than
   * substituting anything for it.
   */
  lastSeenRunId: string | null
}

/**
 * The stored payload for one owned Posting, or `undefined` when there is none.
 *
 * ⚠️ **`(userId, postingId)` is the whole of the ownership check, and it is not
 * a shortcut past one.** A Posting is not addressable without naming a user —
 * that pair is the natural key — so filtering on both *is* the check, exactly as
 * {@link setPostingStatus} describes. "No such Posting" and "someone else's" come
 * back as the same `undefined`, which is what stops the distinction being leaked:
 * Posting ids are derived from an advertisement's URL, so a caller that could
 * tell them apart would be an oracle for whether a stranger has been shown one.
 *
 * ⚠️ **`findUnique`, not `findFirst`.** The pair is a unique index, so this is a
 * single index probe rather than a scan the planner has to be trusted to stop
 * early. One of the two callers spelled it the other way, which is the sort of
 * difference two copies of a read acquire and nobody notices.
 *
 * The `postingId` reaching this must already have been checked against the shape
 * an id can have — `POSTING_ID_PATTERN` in the dashboard. This does not restate
 * that rule, and the CHECK on the column is not a stand-in for it.
 */
export async function postingPayload(
  prisma: DbClient,
  userId: string,
  postingId: string
): Promise<StoredPostingPayload | undefined> {
  const row = await prisma.posting.findUnique({
    where: { userId_postingId: { userId, postingId } },
    select: { payload: true, lastSeenRunId: true },
  })

  if (!row) return undefined

  return {
    payload: row.payload as PostingPayload,
    lastSeenRunId: row.lastSeenRunId,
  }
}

/**
 * The columns one page of Postings may be ordered by, in this package's own
 * vocabulary.
 *
 * ⚠️ **Deliberately a second enum from `POSTING_SORTS` in the dashboard's
 * `posting-query.ts`, and the two must not be merged.** That one is how a *URL*
 * spells a sort — `?sort=lastSeen` — and `list-postings.ts` maps it onto this
 * one. Keeping them separate is what stops an address bar from naming a
 * database column: a value arriving from outside has to survive a mapping
 * somebody wrote, rather than being handed to the query because it happened to
 * parse.
 *
 * Four, and no more. Every entry here is a column with an ordering the table
 * offers; adding one is a decision about the index, not a convenience.
 */
export type PostingOrder = "lastSeenAt" | "title" | "company" | "postedAt"

export type PostingDirection = "asc" | "desc"

export interface PostingPageQuery {
  order: PostingOrder
  direction: PostingDirection
  /** One-based, and clamped against the real page count — see {@link listPostingPage}. */
  page: number
  /**
   * How many rows a page holds. The caller's, not this package's: it is how
   * many rows a *table* shows, and nothing here renders one.
   */
  pageSize: number
  /**
   * Title patterns whose rows are left out of the page and the counts.
   *
   * ⚠️ **Patterns, not words**, and the distinction is what keeps this package
   * free of a dependency on `@workspace/job-search`. A pattern is what
   * `titleMatchPattern()` produces — `" senior "`, space-padded and normalised —
   * and matching it is a substring test against `postings.title_normalized`,
   * which `0010` generates by the same rule. This package filters; it does not
   * decide what a user's word means, exactly as it stores a `payload` it will
   * not parse.
   *
   * Absent or empty filters nothing, which is what makes "no filter set" and
   * "an empty filter" the same query.
   */
  excludeTitlePatterns?: readonly string[]
}

/** One `postings` row as a page of the table needs it. */
export interface PostingListRow {
  /** The derived id — sixteen hex characters. Never `postings.id`. */
  postingId: string
  title: string
  company: string
  location: string
  url: string
  /** `postings_status_check` bounds this; narrowing it is the caller's. */
  status: string
  /** NULL when the advertisement stated no date, or stated a non-date. */
  postedAt: Date | null
  payload: PostingPayload
  firstSeenAt: Date
  lastSeenAt: Date
  /**
   * The name of the Briefing that most recently found this advertisement,
   * flattened out of `postings.last_seen_run_id` → `runs.job_id` → `jobs.name`.
   *
   * ⚠️ **Flattened here rather than handed over as a nested relation, and that
   * is the point of this function existing.** A caller holding
   * `{ lastSeenRun: { job: { name } } }` has to be handed a client that can
   * answer a two-level nested `select` — which is what made the dev fake
   * reimplement the shape, and what made a fake that answered *less* than it was
   * asked take a whole page down with a `TypeError` on `.job`.
   *
   * `null` in two quite different situations, which {@link addedByLink}
   * separates. Either no Run has ever seen this advertisement — the user added
   * it by pasting its link, and there is no Briefing to name — or the relation
   * answered nothing when it should have, which is a client that narrowed the
   * projection rather than anything Postgres can produce. **A blank name is not
   * treated as absent here**; that is a display rule and belongs with whatever
   * renders it.
   */
  briefing: string | null
  /**
   * No Run has ever found this: `first_seen_run_id IS NULL`, which the user
   * pasting a link is the only way to produce.
   *
   * Derived rather than stored, for the reason `posting-source.ts` gives about
   * the board a Posting came from: the row already carries the fact, and a
   * second copy is a second thing to keep true. It is on the row rather than
   * left to the caller so that {@link briefing} being `null` stays a reportable
   * fault — a page full of link-added Postings must not read as a page full of
   * broken relations.
   */
  addedByLink: boolean
}

export interface PostingListPage {
  rows: PostingListRow[]
  /**
   * Every Posting this user has *that the filter admits*, not the length of
   * {@link rows}.
   *
   * ⚠️ **The filter is in this count, deliberately.** It is what
   * {@link PostingListPage.pageCount} is derived from and what a table renders
   * as "N postings", so a total that counted rows the page will not show would
   * paginate past the end and label the table with a number nothing on it adds
   * up to. What was left out is {@link hidden}, which is a separate fact.
   */
  total: number
  /**
   * How many of this user's Postings the filter removed.
   *
   * `0` whenever no patterns were supplied — there is nothing to report and no
   * second count is issued.
   *
   * ⚠️ **This exists so that hiding is never silent.** A filter that quietly
   * shrinks a table is indistinguishable from a briefing that stopped finding
   * anything, and the person best placed to notice is the one who set it. The
   * caller is expected to say the number out loud.
   */
  hidden: number
  /** The page actually read, which is not always the one asked for. */
  page: number
  pageCount: number
}

/**
 * One page of a user's Postings, in the order asked for.
 *
 * ⚠️ **`where: { userId }` is the whole of the row scoping, and it is not
 * optional.** Whatever established *who is asking* says nothing about which rows
 * they may read. A Posting is not addressable without naming a user —
 * `(user_id, posting_id)` is the natural key — so this filter is the check
 * rather than a shortcut past one.
 *
 * ⚠️ **The count and the page are asked for together, and the re-fetch below is
 * what keeps that safe.** `?page=99` on a three-page table must render the last
 * page, not an empty one with working controls underneath it — so the page still
 * has to be clamped against a total only the count knows. Doing that in order
 * meant two serial round trips on *every* render to pay for a case that almost
 * never happens. Asking for both at once and re-fetching only when the requested
 * page really did overshoot costs one round trip in the common case and the
 * original two in the rare one.
 *
 * The price is a query that is sometimes wasted: an empty table and an
 * overshooting page both issue a fetch whose result is discarded. Neither costs
 * wall-clock, because it ran alongside the count either way — and an empty table
 * is the cheapest query this schema has.
 *
 * ⚠️ **A hand-typed `?page=9999` reaches `skip` before the clamp, and that is
 * survivable rather than an oversight.** `OFFSET` can only discard rows that
 * exist, so the work is bounded by how many Postings the *user* has and not by
 * the number they typed — a huge offset over a small table scans the same index
 * entries and returns nothing. **The bound that keeps the value finite in the
 * first place is the caller's**: `MAX_PAGE` in the dashboard's
 * `posting-query.ts` clamps the app's first untrusted GET input, before anything
 * has been counted. That one is about a URL and stays there; this one is about
 * the query and lives here. Two clamps, two owners, and neither stands in for
 * the other.
 *
 * ⚠️ **`orderBy` is tie-broken on `postingId`, and that is a correctness fix,
 * not a nicety.** Offset pagination over a non-unique key — every order here but
 * the dates is non-unique, and two Runs in one slot can share a `last_seen_at`
 * too — lets the database choose freely among equal rows, so the same row can
 * appear on page 1 and page 2 while another appears on neither. The tie-break is
 * in the same direction as the sort so that the default order stays a scan of
 * `postings_user_last_seen_idx`, which carries `(last_seen_at DESC, posting_id
 * DESC)`.
 *
 * **Text ordering follows the database's collation.** Neon's default sorts
 * naturally; a `C`-collation database would put every uppercase title before
 * every lowercase one. One line to know about rather than something to work
 * around in the query.
 */
export async function listPostingPage(
  prisma: DbClient,
  userId: string,
  query: PostingPageQuery
): Promise<PostingListPage> {
  const filtered = query.excludeTitlePatterns?.length ? true : false

  const [total, unfiltered, requested] = await Promise.all([
    prisma.posting.count({ where: postingPageWhere(userId, query) }),
    // Only when there is a filter to account for. Without one the answer is
    // `total` and a second count would be the same query twice.
    filtered ? prisma.posting.count({ where: { userId } }) : Promise.resolve(0),
    findPostingPage(prisma, userId, query, query.page),
  ])

  const hidden = filtered ? unfiltered - total : 0
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize))

  if (total === 0) return { rows: [], total, hidden, page: 1, pageCount }

  const page = Math.min(query.page, pageCount)

  // The speculative fetch was for the page that was asked for. When that was
  // past the end it returned nothing and is discarded, and the clamped page is
  // fetched properly — the only path that still pays two round trips.
  const rows =
    page === query.page
      ? requested
      : await findPostingPage(prisma, userId, query, page)

  return { rows: rows.map(toListRow), total, hidden, page, pageCount }
}

/**
 * Which of this user's rows the page is about.
 *
 * ⚠️ **One builder, used by the count and by the fetch**, because a filter
 * applied to only one of them is a table whose pager walks off the end of
 * itself. That is the same reason `findPostingPage` exists as one function
 * rather than two copies of a projection.
 *
 * ⚠️ **`userId` is the ownership check and not a filter in front of one.** A
 * Posting is not addressable without naming a user — `(user_id, posting_id)` is
 * the natural key — so it is here unconditionally and the exclusions are added
 * beside it, never in place of it.
 *
 * The exclusion is a `NOT (OR …)`: a row is admitted when it matches *no*
 * pattern. Each arm is a substring test against `title_normalized`, the
 * `GENERATED ALWAYS … STORED` column `0010` adds — see the migration for why
 * whole-word matching reduces to a substring at all.
 */
function postingPageWhere(userId: string, query: PostingPageQuery) {
  const patterns = query.excludeTitlePatterns ?? []

  if (patterns.length === 0) return { userId }

  return {
    userId,
    NOT: {
      OR: patterns.map((pattern) => ({
        titleNormalized: { contains: pattern },
      })),
    },
  }
}

/**
 * One slice of `postings`, in the order asked for.
 *
 * Split out because it is issued from two places — speculatively for the page
 * that was asked for, and again for the clamped page when that overshot. The
 * projection has to be identical in both, which is what having one function
 * guarantees. `page` is a parameter rather than being read off `query` precisely
 * because the two disagree in the case this exists to serve.
 */
function findPostingPage(
  prisma: DbClient,
  userId: string,
  query: PostingPageQuery,
  page: number
) {
  return prisma.posting.findMany({
    where: postingPageWhere(userId, query),
    orderBy: orderByFor(query),
    skip: (page - 1) * query.pageSize,
    take: query.pageSize,
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
      // row by row afterwards. **`lastSeenRun`, not `firstSeenRun`** — the
      // Briefing that most recently found the advertisement is the one whose
      // criteria still match it, and it is the sighting the default order runs
      // on. Flattened before it leaves this module; see
      // {@link PostingListRow.briefing}.
      lastSeenRun: { select: { job: { select: { name: true } } } },
      // Not rendered, and not carried past {@link toListRow}: it is what tells
      // "no Run has ever seen this" apart from "the relation answered nothing",
      // which are the same `briefing: null` and are not the same fault.
      firstSeenRunId: true,
    },
  })
}

/**
 * The order one page is read in, written out per column rather than built from
 * a computed key.
 *
 * A `{ [field]: direction }` object would be the same handful of lines with the
 * column name arriving as a string, which is both untypeable against Prisma's
 * input and a shape a reader has to check by hand. Written out, the set of
 * orderable fields is this function and not "whatever `postings` happens to
 * have".
 *
 * **Every branch carries the `postingId` tie-break, in the same direction.** See
 * {@link listPostingPage} for why a page boundary without it shows one row twice
 * and skips another.
 *
 * ⚠️ **`postedAt` is NULLS LAST in *both* directions, and that asymmetry is the
 * point.** It is the one nullable column here, and NULL does not mean "long
 * ago": it means the advertisement did not state a date, or stated one the write
 * path would not read as a date. Postgres would default to NULLS FIRST under
 * `DESC`, which puts every row that says nothing above every row that says
 * something — the opposite of what someone sorting by it is asking for. Sorting
 * ascending does not make those rows interesting either, so they stay at the
 * bottom whichever way the column runs.
 */
function orderByFor(query: PostingPageQuery) {
  const to = query.direction

  switch (query.order) {
    case "lastSeenAt":
      return [{ lastSeenAt: to }, { postingId: to }]

    case "title":
      return [{ title: to }, { postingId: to }]

    case "company":
      return [{ company: to }, { postingId: to }]

    case "postedAt":
      // `as const` so `nulls` narrows to `Prisma.NullsOrder` rather than
      // widening to `string`, which the generated input type refuses.
      return [
        { postedAt: { sort: to, nulls: "last" as const } },
        { postingId: to },
      ]
  }
}

function toListRow(row: {
  postingId: string
  title: string
  company: string
  location: string
  url: string
  status: string
  postedAt: Date | null
  payload: unknown
  firstSeenAt: Date
  lastSeenAt: Date
  lastSeenRun: { job: { name: string } | null } | null
  firstSeenRunId: string | null
}): PostingListRow {
  return {
    postingId: row.postingId,
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    status: row.status,
    postedAt: row.postedAt,
    payload: row.payload as PostingPayload,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    // ⚠️ **Both halves are read optionally although neither relation is
    // optional in the schema.** The nullability is not a claim about the
    // database — it is what keeps a client that answered *less* than it was
    // asked from taking a whole page down with a `TypeError` on `.job`.
    briefing: row.lastSeenRun?.job?.name ?? null,
    addedByLink: row.firstSeenRunId === null,
  }
}

/**
 * Set the status a person chose. `false` means no such Posting for this user.
 *
 * **`userId` in the `where` is not a shortcut past an ownership check — it is
 * half the natural key.** `jobs` needs `requireOwnedJob` because a `jobs.id`
 * addresses any row in the table; a Posting is not addressable without naming a
 * user, so filtering on both *is* the check. One statement also closes the
 * TOCTOU window a load-then-compare would leave open, and the caller gets one
 * answer for "no such Posting" and "someone else's" rather than a distinction
 * that tells a stranger the row exists.
 *
 * `updateMany` rather than `update` for the reason `claimAdHocRun` gives: a
 * guarded write whose row count is the answer. `update` throws on no match,
 * which would turn an ordinary miss into an error.
 */
export async function setPostingStatus(
  prisma: DbClient,
  userId: string,
  postingId: string,
  status: PostingStatus,
  now: Date = new Date()
): Promise<boolean> {
  const updated = await prisma.posting.updateMany({
    where: { userId, postingId },
    data: { status, statusChangedAt: now },
  })

  return updated.count > 0
}

/**
 * Which of these Posting ids this user actually owns, in no particular order.
 *
 * Exists so a caller can act on the *stored* Postings before deleting them —
 * `apps/dashboard` removes each one's cover letter from S3 first, and needs to
 * know which ids are real to avoid addressing objects for rows that never
 * existed. It is also what lets a bulk delete report how many rows it found
 * rather than only how many it removed.
 *
 * **This is not the ownership check, and {@link deletePostings} must not treat
 * it as one.** It answers a question; the check is the `userId` in the delete's
 * own `where`, exactly as it is in {@link setPostingStatus}. Two calls with a
 * gap between them is a TOCTOU window, and the only thing that can happen in it
 * is a Run re-recording an advertisement — which the delete then removes, which
 * is what the user asked for.
 */
export async function ownedPostingIds(
  prisma: DbClient,
  userId: string,
  postingIds: readonly string[]
): Promise<string[]> {
  if (postingIds.length === 0) return []

  const rows = await prisma.posting.findMany({
    where: { userId, postingId: { in: [...postingIds] } },
    select: { postingId: true },
  })

  return rows.map((row) => row.postingId)
}

/**
 * Remove Postings by their derived ids. Returns how many rows went.
 *
 * **`userId` in the `where` is the ownership check**, for the reason
 * {@link setPostingStatus} sets out at length: a Posting is not addressable
 * without naming a user, so filtering on both halves of the natural key *is*
 * the check rather than a shortcut past one. It stays here whether or not the
 * caller already narrowed the list with {@link ownedPostingIds} — a helper that
 * borrowed its safety from an earlier call would be one refactor away from
 * deleting a stranger's rows.
 *
 * ⚠️ **A deleted Posting is not gone for good, by design.**
 * {@link recordPostings} upserts on `(user_id, posting_id)`, so the next Run
 * that re-finds the same advertisement inserts it again at `status = 'new'`.
 * There is no tombstone and adding one is a schema decision, not a tidy-up —
 * anything that surfaces this needs to say so rather than promise finality.
 *
 * Nothing references a Posting, so no cascade is involved: all three of its
 * relations point *out*, at `users` and `runs`, and every one is `Restrict`.
 */
export async function deletePostings(
  prisma: DbClient,
  userId: string,
  postingIds: readonly string[]
): Promise<number> {
  if (postingIds.length === 0) return 0

  const deleted = await prisma.posting.deleteMany({
    where: { userId, postingId: { in: [...postingIds] } },
  })

  return deleted.count
}

/**
 * One row per `postingId`, first occurrence winning.
 *
 * Not defensive tidying. Postgres raises `21000` — *"ON CONFLICT DO UPDATE
 * command cannot affect row a second time"* — when two rows in one statement
 * collide on the conflict target, and two advertisements in one findings list
 * normalising to the same id is exactly what `postingId()` exists to merge:
 * SEEK stamps `?ref=` on its links, so the same posting reached two ways is the
 * ordinary case. First wins because findings arrive best-match first.
 *
 * Deliberately **inside** this helper rather than at the call site — the hazard
 * is a property of the statement, so it is fixed where the statement is.
 */
function dedupe(postings: NewPosting[]): NewPosting[] {
  const seen = new Set<string>()

  return postings.filter((posting) => {
    if (seen.has(posting.postingId)) return false
    seen.add(posting.postingId)
    return true
  })
}
