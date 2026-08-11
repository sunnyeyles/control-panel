import type {
  Board,
  CoverLetterInstructions,
  Job,
  PostingFilters,
  Run,
} from "@workspace/db"

/** `{ where: { id } }`, which is how every single-row lookup here is addressed. */
export interface ById {
  where: { id: string }
}

/**
 * How the Documents table is addressed: by owner, and by owner plus id.
 *
 * **`userId` is not optional and must not become so.** It is the entire
 * ownership check on both `findDocument` and `deleteDocument` — there is no
 * second one underneath, the way `assertOwnedBy` sits under the object store.
 */
export interface DocumentWhere {
  userId: string
  id?: string
}

export interface DocumentsForUser {
  where: { userId: string }
  orderBy?: unknown
}

export interface FindManyJobs {
  where: { userId: string }
  orderBy?: unknown
  /**
   * Honoured, for the reason the Postings one is: a fake that answered *more*
   * than it was asked would hide a component reading a field nobody selected,
   * which in production is `undefined` and here would be a value.
   */
  select?: Record<string, boolean>
}

/**
 * How the Postings table is filtered here: always by owner, sometimes by an
 * explicit list of ids.
 *
 * **`userId` is not optional and must not become so.** A Posting is not
 * addressable without naming a user — that is what makes filtering on the
 * natural key an ownership check rather than a shortcut past one, in
 * `@workspace/db` and here.
 *
 * `postingId.in` is what `ownedPostingIds()` and `deletePostings()` add. Only
 * the `in` form is understood; a bare string or any other operator falls
 * through to {@link matchesPostingWhere}, which throws by name rather than
 * quietly matching everything and deleting a page.
 */
export interface PostingWhere {
  userId: string
  postingId?: { in: string[] }
  /**
   * The "not scored against this document" predicate, and the only `OR` this
   * fake understands.
   *
   * ⚠️ **Two arms, and dropping either would break the loop it serves in
   * opposite directions.** `unmatchedAgainst()` in `@workspace/db` spells it
   * out rather than relying on a `not` filter's null handling; matching only
   * the `not` arm here would hide every Posting nobody has scored — the ones
   * the loop exists to find — and matching only the `null` arm would never
   * re-score after the user uploads a new CV.
   */
  OR?: readonly PostingMatchClause[]
  /**
   * The account's title filter, as `listPostingPage` spells it: admit a row that
   * matches *none* of these patterns.
   *
   * Typed exactly as the real query builds it rather than loosely, so a change
   * to that shape is a compile error here instead of a clause this fake ignores
   * — which under the flag would show every posting the filter is supposed to
   * hide.
   */
  NOT?: { OR: TitleExclusion[] }
}

/** One arm of the exclusion: a substring test against the generated column. */
export interface TitleExclusion {
  titleNormalized: { contains: string }
}

export type PostingMatchClause =
  { matchResumeId: null } | { matchResumeId: { not: string } }

/**
 * The whole of the row scoping the table applies, and the whole of what the
 * count is asked for.
 */
export interface PostingsForUser {
  where: PostingWhere
}

/**
 * What `listPostings()` asks for.
 *
 * ⚠️ **`select` is applied for real, and it used not to be.** Answering the
 * whole row was defensible while every selected field was a column: the answer
 * was a superset of the question, and no caller could tell. It stopped being
 * defensible the moment the `select` named a **relation** — a whole `postings`
 * row does not carry `lastSeenRun`, so ignoring the `select` handed the page an
 * `undefined` where a Briefing's name belonged and the dialog rendered a blank.
 * Silently, in the one environment the dialog is built in. See
 * {@link DevDb.projectPosting}, which throws on a shape it cannot serve rather
 * than repeating that.
 */
export interface FindManyPostings extends PostingsForUser {
  orderBy?: PostingOrderBy[]
  skip?: number
  take?: number
  select?: PostingSelect
}

/**
 * A `select` as this fake reads it: `true` for a column of `postings`, or a
 * nested `select` for one of its relations.
 */
export type PostingSelect = Record<string, boolean | NestedSelect>

/** The relation half of a `select`, left `unknown` inside so it is checked. */
export interface NestedSelect {
  select?: Record<string, unknown>
}

/**
 * One clause, as Prisma spells it.
 *
 * Two spellings, because Prisma has two: `{ field: "desc" }` for a column that
 * cannot be null, and `{ field: { sort: "desc", nulls: "last" } }` for one that
 * can. `postings.posted_at` is the only nullable column this table orders by,
 * and it uses the second — see `orderByFor` in `lib/postings/list-postings.ts`.
 *
 * Exported so `list-postings.test.ts`'s own `FakeDb` can type its `orderBy`
 * against the same shape instead of restating it under a different name.
 */
export type PostingOrderBy = Record<string, SortDirection | NullableSort>

export type SortDirection = "asc" | "desc"

export interface NullableSort {
  sort: SortDirection
  nulls?: "first" | "last"
}

/** How the compound unique is addressed — the shape Prisma generates for it. */
export interface ByUserAndPostingId {
  where: { userId_postingId: { userId: string; postingId: string } }
}

/** How the one row-per-user table is addressed: its owner *is* its primary key. */
export interface ByUserId {
  where: { userId: string }
}

/**
 * Both columns are `@default("")` in the schema, so either half of the upsert
 * may leave either field out and get the empty string — matched here rather
 * than assumed, since a `create` that omitted one would otherwise write
 * `undefined` into a column typed `string`.
 */
export type CoverLetterInstructionsValues = Partial<
  Pick<CoverLetterInstructions, "instructions" | "exampleLetter">
>

export interface UpsertCoverLetterInstructions extends ByUserId {
  create: { userId: string } & CoverLetterInstructionsValues
  update: CoverLetterInstructionsValues
}

/**
 * Both halves carry the whole list, because a save is the whole setting — see
 * `savePostingFilters`. Neither is `Partial`: an omitted `titleExclusions` would
 * be a write of `undefined` into a column typed `string[]`, and the real thing
 * has no default to fall back on the way the cover-letter columns do.
 */
export interface UpsertPostingFilters extends ByUserId {
  create: { userId: string; titleExclusions: string[] }
  update: { titleExclusions: string[] }
}

export interface UpsertBoard extends ByUserId {
  create: { userId: string; snapshot: unknown }
  update: { snapshot: unknown }
}

export type JobCreateData = Omit<Job, "id" | "createdAt" | "updatedAt">

/** What `startAdHocRun()` inserts — everything else takes a column default. */
export type RunCreateData = Pick<Run, "jobId" | "scheduledFor" | "status">

/** What `runningRunForJob()` asks for. */
export interface RunningRunQuery {
  where: {
    jobId: string
    status: string
    startedAt: { gte: Date }
  }
  orderBy?: unknown
}

/**
 * The columns every Postings filter in this app is written against.
 *
 * `matchResumeId` is optional so that the narrower doubles which share this
 * predicate — `posting-actions.test.ts` builds one — do not have to carry a
 * column their `where` never mentions. Absent is read as NULL, which is what an
 * unscored Posting holds.
 *
 * `titleNormalized` is optional because the delete path builds its own rows from
 * the two identifying columns and has no title in hand — and because a `where`
 * with no exclusion in it never reads the field. A row that *is* filtered on and
 * carries no value is a fixture that has drifted, and
 * {@link matchesPostingWhere} says so by name rather than silently admitting it.
 */
export interface PostingKey {
  userId: string
  postingId: string
  matchResumeId?: string | null
  titleNormalized?: string | null
}
