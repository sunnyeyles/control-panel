import type { Posting } from "@workspace/db"
import { DevPrismaError } from "./errors"
import { matchesPostingWhere, removeMatchingPostings } from "./posting-where"
import { sortPostings } from "./posting-order"
import type { DevStore } from "./store"
import type {
  ByUserAndPostingId,
  FindManyPostings,
  NestedSelect,
  PostingsForUser,
  PostingSelect,
  PostingWhere,
} from "./query-types"

/**
 * The Postings table, which is the one delegate here that is asked to
 * **order, page and project for real** — see findManyPostings and projectPosting.
 */
export function createPostingDelegate(store: DevStore) {
  return {
    count: async (query: PostingsForUser) => countPostings(store, query.where),
    findMany: async (query: FindManyPostings) => findManyPostings(store, query),
    /**
     * Both single-row reads, because there is one.
     *
     * `loadStoredPosting` and `loadPostingDetail` used to spell the same
     * lookup two ways — one compound `findUnique`, one plain `findFirst` — and
     * this delegate carried both. They share `postingPayload` in
     * `@workspace/db` now, so `findFirst` went with the second spelling.
     *
     * Answering from **both** halves of the natural key is the part that must
     * not be relaxed: that pair *is* the ownership check, so a fake that
     * answered from `postingId` alone would let the real one stop scoping
     * without anything here noticing.
     */
    findUnique: async (query: ByUserAndPostingId) =>
      findPosting(store, query.where.userId_postingId),
    updateMany: async (query: {
      where: { userId: string; postingId: string }
      data: Partial<Posting>
    }) => updatePostings(store, query.where, query.data),
    deleteMany: async (query: { where: PostingWhere }) =>
      deletePostings(store, query.where),
  }
}

function countPostings(store: DevStore, where: PostingWhere): number {
  return matching(store, where).length
}

/**
 * ⚠️ **`orderBy` is honoured here, unlike in findManyJobs.**
 *
 * That one may ignore it because every caller wants the same order. This one
 * may not: the columns are sortable, the order is chosen from the URL, and a
 * fake that ignored it would render the table in one fixed order under
 * `DEV_AUTH_BYPASS` — silently, correctly-looking, and wrong — in exactly the
 * environment the table is built in. `skip` and `take` are honoured for the
 * same reason: paging that did nothing would make every page identical.
 *
 * ⚠️ **`select` is honoured too, relations included** — see projectPosting.
 * It was ignored until the table started asking which Briefing found a Posting,
 * at which point ignoring it stopped being a harmless superset and became a
 * blank in the dialog.
 */
function findManyPostings(store: DevStore, query: FindManyPostings): unknown[] {
  const ordered = sortPostings(
    matching(store, query.where),
    query.orderBy ?? []
  )
  const from = query.skip ?? 0

  const page = ordered.slice(
    from,
    query.take === undefined ? undefined : from + query.take
  )

  const select = query.select
  if (select === undefined) return page

  return page.map((row) => projectPosting(store, row, select))
}

/**
 * One row as the `select` asked for it — columns copied across, relations
 * resolved against the other fixtures.
 *
 * ⚠️ **Every branch here either answers or throws; none returns
 * `undefined`.** That is the whole file's principle applied where the
 * alternative is invisible: a projection that quietly skipped a field it did
 * not understand would render a missing Briefing exactly like a Briefing
 * whose name is blank, and the page would look like it worked.
 *
 * A query carrying no `select` at all is not a shape to handle here —
 * findManyPostings answers those with whole rows, which is what
 * Prisma does too.
 */
function projectPosting(
  store: DevStore,
  row: Posting,
  select: PostingSelect
): Record<string, unknown> {
  const projected: Record<string, unknown> = {}

  for (const [field, wanted] of Object.entries(select)) {
    if (wanted === false) continue

    if (wanted === true) {
      if (!(field in row)) {
        throw new DevPrismaError(
          `prisma.posting.findMany select.${field}`,
          "That column is not on a Posting. Add it to lib/dev/fixtures.ts, or fix the select in lib/postings/list-postings.ts."
        )
      }

      projected[field] = row[field as keyof Posting]
      continue
    }

    if (field === "lastSeenRun" && isBriefingNameSelect(wanted)) {
      const briefing = briefingThatFound(store, row)
      projected[field] = briefing === null ? null : { job: { name: briefing } }
      continue
    }

    throw new DevPrismaError(
      `prisma.posting.findMany select.${field}`,
      "The only relation understood here is `lastSeenRun: { select: { job: { select: { name: true } } } }`. Teach projectPosting() in this file the new shape — leaving it out would answer undefined and render a blank."
    )
  }

  return projected
}

/**
 * The name of the Briefing that most recently found a Posting, joined out of
 * the fixtures rather than stored on the row: `lastSeenRunId` → `runs.job_id`
 * → `jobs.name`, which is the join the real query makes.
 *
 * Joining beats denormalising it onto the fixture rows, for the reason
 * devPostings derives its ids rather than writing them out: a name
 * copied onto a Posting could disagree with the Briefing that fixture claims
 * to have come from, and disagree silently.
 *
 * ⚠️ **`null` and a dangling reference are not the same thing.** A Posting
 * with no `lastSeenRunId` is one the user added by pasting its link, which
 * `0009` made legal and which the page renders as "Added by link" — so it
 * answers `null` rather than throwing. An id that names *no* run still
 * throws: the foreign key makes that impossible in Postgres, so it is a
 * fixture that has drifted, and it should say so by name here rather than
 * reach `list-postings.ts` as an unnamed Briefing.
 */
function briefingThatFound(store: DevStore, row: Posting): string | null {
  if (row.lastSeenRunId === null) return null

  const run = store.runs.find((candidate) => candidate.id === row.lastSeenRunId)
  const job = run
    ? store.jobs.find((candidate) => candidate.id === run.jobId)
    : null

  if (!job) {
    throw new DevPrismaError(
      "prisma.posting.findMany select.lastSeenRun",
      `No run ${row.lastSeenRunId} with a briefing behind it. Every posting in lib/dev/fixtures.ts must name a run from devRuns() whose job is in devJobs() — the foreign keys make that so in Postgres.`
    )
  }

  return job.name
}

/**
 * Addressed by the natural key, never by `postings.id`. Both halves are in
 * the `where`, so there is no ownership left to check separately — which is
 * the property `setPostingStatus()` in `@workspace/db` rests on.
 */
function findPosting(
  store: DevStore,
  key: { userId: string; postingId: string }
): Posting | null {
  return (
    store.postings.find(
      (row) => row.userId === key.userId && row.postingId === key.postingId
    ) ?? null
  )
}

/**
 * The row count as the answer, which is how `setPostingStatus()` distinguishes
 * "no such Posting for this user" from a write it made.
 */
function updatePostings(
  store: DevStore,
  where: { userId: string; postingId: string },
  data: Partial<Posting>
): { count: number } {
  const row = findPosting(store, where)
  if (!row) return { count: 0 }

  Object.assign(row, data)
  return { count: 1 }
}

/**
 * The row count as the answer, which is how `deletePostings()` in
 * `@workspace/db` reports how many Postings actually went.
 *
 * Splices out of the backing array rather than rebuilding it, because
 * postings is `readonly` and every other method reads through it —
 * a reassignment would leave `findPosting` looking at the old rows.
 */
function deletePostings(
  store: DevStore,
  where: PostingWhere
): { count: number } {
  return { count: removeMatchingPostings(store.postings, where).length }
}

function matching(store: DevStore, where: PostingWhere): Posting[] {
  return store.postings.filter((row) => matchesPostingWhere(row, where))
}

/**
 * Exactly `{ select: { job: { select: { name: true } } } }`, and nothing wider.
 *
 * Matched by shape rather than merely by the key `lastSeenRun`, in the spirit of
 * executeRaw: a caller that starts asking the relation for a second field gets
 * a named refusal here, instead of a row missing whichever field this fake
 * never learned to fill in.
 */
function isBriefingNameSelect(wanted: NestedSelect): boolean {
  const runSelect = wanted.select

  if (!isPlainObject(runSelect) || Object.keys(runSelect).length !== 1) {
    return false
  }

  const job = runSelect.job
  if (!isPlainObject(job) || !isPlainObject(job.select)) return false

  const fields = Object.entries(job.select)

  return (
    fields.length === 1 && fields[0]?.[0] === "name" && fields[0]?.[1] === true
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && value.constructor === Object
  )
}
