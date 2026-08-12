import { Prisma, type PrismaClient } from "./generated/prisma/client.ts"
import type { PostingPayload, PostingStatus } from "./types.ts"

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * The four statuses, in the order a person moves through them.
 *
 * Here rather than in the type-only `types.ts`, which would start emitting.
 * `satisfies` only catches a value that is *not* a {@link PostingStatus} — a
 * short array still compiles, so the exhaustiveness gate is
 * `POSTING_STATUS_LABELS` in `apps/dashboard/lib/postings/`.
 */
export const POSTING_STATUSES = [
  "new",
  "applied",
  "not-interested",
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
   * When the advertisement said the role was posted, parsed. Absent when it
   * said nothing, or said something that is not a date. A `Date` rather than
   * the payload's string because the table orders by the column.
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
   * When they were found. The caller's clock, not `now()`: the worker passes
   * the Run's *slot*, the backfill each historic Run's `started_at`, so
   * `first_seen_at` never means "when the backfill ran".
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
 * ⚠️ **What the `DO UPDATE SET` list omits is load-bearing, and every omission
 * is silently undoable.**
 *
 * - `status` and `status_changed_at` are the only things a *person* writes
 *   here; updating them would walk an `applied` Posting back to `new` on every
 *   re-find, on a schedule, with no error and no trace.
 * - The five `match_*` columns would go to NULL — a Run cannot read the
 *   document a score came from — blanking a score nightly, and the `0011`
 *   completeness CHECK would not catch it because all five go together.
 *   {@link recordPostingMatch} is the only writer.
 * - `first_seen_at` / `first_seen_run_id` answer a question a second sighting
 *   cannot change; writing them would make every row claim the latest Run.
 * - The trailing `WHERE` makes this order-independent: the backfill walks Runs
 *   oldest-first while live ticks record new ones, and without it a late-
 *   arriving old sighting drags `last_seen_at` backwards.
 *
 * Raw SQL, not `upsert` in a loop: one atomic statement and one round trip,
 * where a read-then-write would make two overlapping ticks a unique violation.
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
 * ⚠️ **`DO NOTHING` is the entire reason this exists beside
 * {@link recordPostings} rather than as a flag on it.** A link may *create* a
 * Posting and may never *revise* one: an update would walk `status` back to
 * `new`, overwrite `last_seen_run_id` with this path's NULL, swap a Run's
 * fuller `payload` for a thinner one, and blank the five `match_*` columns.
 *
 * The caller checks for an existing Posting first, so this clause only covers
 * the race that check cannot. A `false` return is not a failure — it means the
 * advertisement is already tracked.
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
   * The advertisement as its producer validated it, opaque to this package —
   * the schema lives on the other side of the seam, so callers own a "the
   * stored payload no longer parses" branch rather than being handed one.
   */
  payload: PostingPayload
  /**
   * `last_seen_run_id`: provenance, no part of the identity. `null` for a
   * Posting the user added by pasting its link.
   */
  lastSeenRunId: string | null
  /**
   * The match against the user's resume, or `null` when nobody has scored it.
   *
   * ⚠️ Read with the payload, not with the page: `reason` and `gaps` are a page
   * of prose across twenty-five rows. Only the *score* travels with the page,
   * because a column sorts on it.
   */
  match: PostingMatchRow | null
}

/**
 * The stored payload for one owned Posting, or `undefined` when there is none.
 *
 * ⚠️ **`(userId, postingId)` is the ownership check, not a shortcut past one** —
 * the pair is the natural key, so filtering on both *is* the check. "No such
 * Posting" and "someone else's" are both `undefined`, so the distinction cannot
 * be used as an oracle for what a stranger has been shown.
 *
 * ⚠️ **`findUnique`, not `findFirst`** — the pair is a unique index, so this is
 * one index probe rather than a scan the planner must be trusted to stop early.
 *
 * The caller must already have checked the id's shape against
 * `POSTING_ID_PATTERN`; the column's CHECK is not a stand-in for that.
 */
export async function postingPayload(
  prisma: DbClient,
  userId: string,
  postingId: string
): Promise<StoredPostingPayload | undefined> {
  const row = await prisma.posting.findUnique({
    where: { userId_postingId: { userId, postingId } },
    select: {
      payload: true,
      lastSeenRunId: true,
      matchScore: true,
      matchReason: true,
      matchGaps: true,
      matchResumeId: true,
      matchedAt: true,
    },
  })

  if (!row) return undefined

  return {
    payload: row.payload as PostingPayload,
    lastSeenRunId: row.lastSeenRunId,
    match: toMatchRow(row),
  }
}

/**
 * The columns one page of Postings may be ordered by, in this package's own
 * vocabulary.
 *
 * ⚠️ **Deliberately a second enum from `POSTING_SORTS` in the dashboard's
 * `posting-query.ts`, and the two must not be merged.** That one is how a *URL*
 * spells a sort; `list-postings.ts` maps it onto this one, so an address bar can
 * never name a database column directly.
 *
 * Adding an entry is a decision about the index, not a convenience — `match`
 * came with `postings_user_match_idx` in `0011`.
 */
export type PostingOrder =
  "lastSeenAt" | "title" | "company" | "postedAt" | "match"

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
   * ⚠️ **Patterns, not words** — that is what keeps this package free of a
   * dependency on `@workspace/job-search`. A pattern is what
   * `titleMatchPattern()` produces (`" senior "`, space-padded and normalised),
   * matched as a substring against the `title_normalized` column `0010`
   * generates by the same rule. Absent or empty filters nothing.
   */
  excludeTitlePatterns?: readonly string[]
}

/**
 * One Posting's match against a resume, as a reader gets it.
 *
 * The five columns are set together or NULL together, so a reader is handed
 * either all of this or nothing — see `postings_match_complete_check`.
 */
export interface PostingMatchRow {
  /** 0–100. A CHECK on the column holds the bound, not this type. */
  score: number
  reason: string
  /**
   * The stated requirements the resume does not evidence. Opaque here, exactly
   * as {@link PostingPayload} is — the schema is on the other side of the seam.
   */
  gaps: unknown
  /**
   * The `documents.id` this was scored against.
   *
   * ⚠️ **The staleness key, and the only one.** A caller compares it with the
   * user's current resume; this package does not know which that is, which is
   * why the id is carried out rather than reduced to a boolean.
   *
   * **`documentId`, although the column is `match_resume_id`** — the column
   * predates `documents` and cannot be renamed cheaply, so the translation
   * happens here and in {@link recordPostingMatch}.
   */
  documentId: string
  matchedAt: Date
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
   * 0–100, or `null` when nobody has scored it yet. **The score and nothing
   * else** — the reason and gaps are read with the payload
   * ({@link StoredPostingPayload.match}), because a page carries twenty-five
   * rows and at most one is ever expanded.
   */
  matchScore: number | null
  /**
   * The Briefing that most recently found this, flattened out of
   * `postings.last_seen_run_id` → `runs.job_id` → `jobs.name`.
   *
   * ⚠️ **Flattened rather than handed over as a nested relation** — a caller
   * holding `{ lastSeenRun: { job: { name } } }` needs a client that answers a
   * two-level nested `select`, and a dev fake that answered *less* than it was
   * asked took a whole page down with a `TypeError` on `.job`.
   *
   * `null` either because no Run has ever seen it — {@link addedByLink} — or
   * because the relation answered nothing when it should have, which is a
   * reportable fault. A blank name is not treated as absent here.
   */
  briefing: string | null
  /**
   * `first_seen_run_id IS NULL`: the user pasted a link. Derived rather than
   * stored, and on the row rather than left to the caller so that
   * {@link briefing} being `null` stays a reportable fault.
   */
  addedByLink: boolean
}

export interface PostingListPage {
  rows: PostingListRow[]
  /**
   * Every Posting this user has *that the filter admits*, not `rows.length`.
   * The filter is in the count deliberately: {@link pageCount} derives from it,
   * so counting rows the page will not show would paginate past the end.
   */
  total: number
  /**
   * How many of this user's Postings the filter removed; `0` when no patterns
   * were supplied. **Exists so that hiding is never silent** — a filter that
   * quietly shrinks a table looks exactly like a briefing that stopped finding
   * anything. The caller is expected to say the number out loud.
   */
  hidden: number
  /** The page actually read, which is not always the one asked for. */
  page: number
  pageCount: number
}

/**
 * One page of a user's Postings, in the order asked for.
 *
 * ⚠️ **`where: { userId }` is the row scoping and is not optional.** A Posting
 * is not addressable without naming a user — `(user_id, posting_id)` is the
 * natural key — so the filter *is* the check, not a shortcut past one.
 *
 * ⚠️ **The count and the page are asked for together, and the re-fetch below
 * keeps that safe.** `?page=99` on a three-page table must render the last page,
 * which needs a total only the count knows; doing it in order cost two serial
 * round trips on every render. Speculating costs one in the common case and the
 * original two when the page really did overshoot, at the price of a discarded
 * query that ran alongside the count anyway.
 *
 * A hand-typed `?page=9999` reaches `skip` before the clamp and is survivable:
 * `OFFSET` only discards rows that exist, so the work is bounded by the user's
 * row count. Keeping the value finite is the caller's job — `MAX_PAGE` in the
 * dashboard's `posting-query.ts`.
 *
 * ⚠️ **`orderBy` is tie-broken on `postingId`, and that is a correctness fix.**
 * Offset pagination over a non-unique key lets the database choose freely among
 * equal rows, so one row appears on two pages and another on none. The tie-break
 * runs in the sort's direction so the default order stays a scan of
 * `postings_user_last_seen_idx` — `(last_seen_at DESC, posting_id DESC)`.
 *
 * Text ordering follows the database's collation: Neon's default sorts
 * naturally, a `C`-collation database would sort uppercase titles first.
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
 * ⚠️ **One builder for the count and the fetch**, because a filter applied to
 * only one of them is a table whose pager walks off the end of itself.
 *
 * ⚠️ **`userId` is the ownership check, not a filter in front of one** — it is
 * here unconditionally, with exclusions beside it and never in place of it.
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
 * Issued twice — speculatively for the requested page, then again for the
 * clamped page when that overshot — and the projection must be identical in
 * both. `page` is a parameter rather than read off `query` because the two
 * disagree in exactly the case this exists to serve.
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
      // The score alone — see {@link PostingListRow.matchScore}.
      matchScore: true,
      // **`lastSeenRun`, not `firstSeenRun`** — the Briefing that most recently
      // found it is the one whose criteria still match, and it is the sighting
      // the default order runs on. Flattened before it leaves this module.
      lastSeenRun: { select: { job: { select: { name: true } } } },
      // Not rendered: it is what tells "no Run has ever seen this" apart from
      // "the relation answered nothing" — the same `briefing: null`, different
      // faults.
      firstSeenRunId: true,
    },
  })
}

/**
 * The order one page is read in, written out per column rather than built from
 * a computed key.
 *
 * A computed `{ [field]: direction }` would take the column name as a string,
 * which is untypeable against Prisma's input; written out, the orderable set is
 * this function rather than "whatever `postings` happens to have".
 *
 * **Every branch carries the `postingId` tie-break, in the same direction** —
 * see {@link listPostingPage} for why a page boundary without it shows one row
 * twice and skips another.
 *
 * ⚠️ **`postedAt` is NULLS LAST in *both* directions.** NULL means the
 * advertisement stated no date, not "long ago", and Postgres defaults to NULLS
 * FIRST under `DESC` — putting every row that says nothing on top.
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

    case "match":
      // NULLS LAST both ways, as `postedAt`: an unscored Posting is not a
      // badly-matched one, and under `DESC` Postgres would sort every row
      // nobody has looked at above every row somebody has.
      return [
        { matchScore: { sort: to, nulls: "last" as const } },
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
  matchScore: number | null
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
    matchScore: row.matchScore,
    // ⚠️ Read optionally although neither relation is optional in the schema —
    // it keeps a client that answered *less* than it was asked from taking a
    // whole page down with a `TypeError` on `.job`.
    briefing: row.lastSeenRun?.job?.name ?? null,
    addedByLink: row.firstSeenRunId === null,
  }
}

/**
 * The five match columns as one object, or `null`.
 *
 * ⚠️ **`match_score IS NULL` is the test; the other four are read through it.**
 * `postings_match_complete_check` makes all five NULL or set together, so a
 * score with a missing reason is a state the database refuses.
 *
 * ⚠️ **Nullish rather than `=== null`, and the `??` fallbacks with it** — both
 * are for the clients that are not Postgres. A hand-written dev fake answering
 * *less* than it was asked would otherwise yield a match object with
 * `undefined` inside it, rendering blank rather than absent.
 */
function toMatchRow(row: {
  matchScore?: number | null
  matchReason?: string | null
  matchGaps?: unknown
  matchResumeId?: string | null
  matchedAt?: Date | null
}): PostingMatchRow | null {
  if (row.matchScore === null || row.matchScore === undefined) return null

  return {
    score: row.matchScore,
    reason: row.matchReason ?? "",
    gaps: row.matchGaps ?? [],
    documentId: row.matchResumeId ?? "",
    matchedAt: row.matchedAt ?? new Date(0),
  }
}

/** One score, and the document it was computed against. */
export interface PostingMatchWrite {
  userId: string
  postingId: string
  /** 0–100. The CHECK on the column is what enforces it, not this package. */
  score: number
  reason: string
  /**
   * The stated requirements the resume does not evidence, as its producer
   * validated them. Stored as JSON and never read here — see
   * {@link PostingMatchRow.gaps}.
   */
  gaps: unknown
  /**
   * The `documents.id` scored against. Deliberately not an FK; see `0011`, and
   * spelled `documentId` rather than after its column for the reason
   * {@link PostingMatchRow.documentId} gives.
   */
  documentId: string
  /** When it was scored — the caller's clock, per {@link SeenPostings.seenAt}. */
  matchedAt: Date
}

/**
 * Record a match against a Posting that already exists. `false` means there is
 * no such Posting for this user.
 *
 * ⚠️ **It updates and never inserts.** A statement that could insert would let
 * a caller mint a Posting out of a score — no title, no URL, no sighting.
 * `updateMany` and the `userId` in the `where` are both as
 * {@link setPostingStatus} sets out.
 *
 * All five columns go in one statement, which is what keeps
 * `postings_match_complete_check` satisfiable: there is no legal intermediate.
 */
export async function recordPostingMatch(
  prisma: DbClient,
  match: PostingMatchWrite
): Promise<boolean> {
  const updated = await prisma.posting.updateMany({
    where: { userId: match.userId, postingId: match.postingId },
    data: {
      matchScore: match.score,
      matchReason: match.reason,
      matchGaps: match.gaps as Prisma.InputJsonValue,
      matchResumeId: match.documentId,
      matchedAt: match.matchedAt,
    },
  })

  return updated.count > 0
}

/**
 * "Not scored against this document", as one predicate two readers share.
 *
 * ⚠️ **The `null` arm is not redundant.** A bare inequality compiles to
 * `col <> $1`, which NULL does not satisfy — every never-scored Posting would
 * be invisible to the one loop whose job is to find them. Spelled out rather
 * than left to a `not` filter, whose null handling is a client-version detail.
 *
 * One function because the list and the count must agree exactly: a loop that
 * stops on a count from a different predicate never terminates, or stops early.
 */
function unmatchedAgainst(documentId: string) {
  return {
    OR: [{ matchResumeId: null }, { matchResumeId: { not: documentId } }],
  }
}

/**
 * The Postings this user has that are not scored against `documentId`, newest
 * sighting first, at most `limit` of them.
 *
 * **Bounded, and the caller says by how much** — scoring is one model call per
 * row against a whole CV, so an unbounded list is an unbounded bill and a
 * request that outlives its timeout. Ordered `last_seen_at DESC` so newly-found
 * advertisements score before a month-old backlog.
 */
export async function listUnmatchedPostingIds(
  prisma: DbClient,
  userId: string,
  documentId: string,
  limit: number
): Promise<string[]> {
  if (limit <= 0) return []

  const rows = await prisma.posting.findMany({
    where: { userId, ...unmatchedAgainst(documentId) },
    orderBy: [{ lastSeenAt: "desc" }, { postingId: "desc" }],
    take: limit,
    select: { postingId: true },
  })

  return rows.map((row) => row.postingId)
}

/**
 * How many of this user's Postings are not scored against `documentId`.
 *
 * The same predicate as {@link listUnmatchedPostingIds}, beside it: the scoring
 * loop runs on "is there more", and inferring that from a short page would stop
 * early the first time a round returned fewer rows than it asked for.
 */
export async function countUnmatchedPostings(
  prisma: DbClient,
  userId: string,
  documentId: string
): Promise<number> {
  return prisma.posting.count({
    where: { userId, ...unmatchedAgainst(documentId) },
  })
}

/**
 * Set the status a person chose. `false` means no such Posting for this user.
 *
 * **`userId` in the `where` is not a shortcut past an ownership check — it is
 * half the natural key.** `jobs` needs `requireOwnedJob` because a `jobs.id`
 * addresses any row; a Posting is not addressable without naming a user. One
 * statement also closes the TOCTOU window a load-then-compare would leave, and
 * "no such Posting" and "someone else's" get the same answer.
 *
 * `updateMany` rather than `update`, per `claimAdHocRun`: a guarded write whose
 * row count is the answer, where `update` throws on an ordinary miss.
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
 * `apps/dashboard` clears each one's cover letter from S3 first — and so a bulk
 * delete can report how many rows it found, not only how many it removed.
 *
 * **This is not the ownership check, and {@link deletePostings} must not treat
 * it as one.** The check is the `userId` in the delete's own `where`. The gap
 * between the two calls is a TOCTOU window whose only occupant is a Run
 * re-recording an advertisement — which the delete then removes anyway.
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
 * **`userId` in the `where` is the ownership check**, per
 * {@link setPostingStatus}. It stays here whether or not the caller narrowed
 * the list with {@link ownedPostingIds} — a helper that borrowed its safety
 * from an earlier call is one refactor away from deleting a stranger's rows.
 *
 * ⚠️ **A deleted Posting is not gone for good, by design.**
 * {@link recordPostings} upserts on `(user_id, posting_id)`, so the next Run to
 * re-find the advertisement inserts it again at `status = 'new'`. There is no
 * tombstone; anything surfacing this must not promise finality.
 *
 * No cascade is involved: all three relations point *out*, and all are
 * `Restrict`.
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
 * collide on the conflict target, and SEEK stamps `?ref=` on its links, so the
 * same posting reached two ways is the ordinary case. First wins because
 * findings arrive best-match first. Inside the helper, because the hazard is a
 * property of the statement.
 */
function dedupe(postings: NewPosting[]): NewPosting[] {
  const seen = new Set<string>()

  return postings.filter((posting) => {
    if (seen.has(posting.postingId)) return false
    seen.add(posting.postingId)
    return true
  })
}
