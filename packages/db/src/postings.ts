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
  /** `last_seen_run_id`: provenance, and no part of the identity. */
  lastSeenRunId: string
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
