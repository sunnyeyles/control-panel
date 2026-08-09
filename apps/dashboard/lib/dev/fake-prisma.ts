import {
  devCoverLetterInstructions,
  devDocuments,
  devJobs,
  devPostings,
  devRuns,
} from "@/lib/dev/fixtures"
import type {
  Board,
  CoverLetterInstructions,
  Document,
  Job,
  Posting,
  PrismaClient,
  Run,
} from "@workspace/db"

/**
 * Postgres, for `DEV_AUTH_BYPASS=1` only — an in-memory stand-in that honours
 * the queries this app makes and refuses every other one by name.
 *
 * **It filters and orders for real rather than returning canned rows**, so the
 * user-scoping in `lib/postings/list-postings.ts` and `job-actions.ts` stays
 * visible to anyone editing around it. Follows the `FakeDb` in
 * `lib/postings/list-postings.test.ts`.
 *
 * **Writes survive the process, not a restart.** A pause has to outlive the
 * redirect after it or the form looks broken; a restart restoring the fixtures
 * is the useful behaviour.
 *
 * ⚠️ **Unsupported calls throw** rather than answering `undefined` and
 * surfacing as a null dereference three frames away. See {@link guard}.
 */
export function createDevPrisma(): PrismaClient {
  const db = new DevDb()

  return guard({
    job: {
      findMany: async (query: FindManyJobs) => db.findManyJobs(query),
      findUnique: async (query: ById) => db.findJob(query.where.id),
      create: async (query: { data: JobCreateData }) =>
        db.createJob(query.data),
      update: async (query: ById & { data: Partial<Job> }) =>
        db.updateJob(query.where.id, query.data),
    },
    run: {
      findFirst: async (query: RunningRunQuery) => db.findRunningRun(query),
      create: async (query: { data: RunCreateData }) =>
        db.createRun(query.data),
      update: async (query: ById & { data: Partial<Run> }) =>
        db.updateRun(query.where.id, query.data),
      updateMany: async (query: {
        where: { id: string; status?: string }
        data: Partial<Run>
      }) => db.updateRunsGuarded(query.where, query.data),
    },
    /**
     * The Postings table, which is the one delegate here that is asked to
     * **order, page and project for real** — see {@link DevDb.findManyPostings}
     * and {@link DevDb.projectPosting}.
     */
    posting: {
      count: async (query: PostingsForUser) => db.countPostings(query.where),
      findMany: async (query: FindManyPostings) => db.findManyPostings(query),
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
        db.findPosting(query.where.userId_postingId),
      updateMany: async (query: {
        where: { userId: string; postingId: string }
        data: Partial<Posting>
      }) => db.updatePostings(query.where, query.data),
      deleteMany: async (query: { where: PostingWhere }) =>
        db.deletePostings(query.where),
    },
    /**
     * The Documents shelf. Four calls, and the two lookups are both scoped by
     * owner because in the real thing that scoping *is* the ownership check —
     * `findDocument` and `deleteDocument` in `@workspace/db` have no other one.
     * A fake that answered from the id alone would let that scoping be dropped
     * without anything here noticing, which is the same argument
     * `posting.findFirst` above makes.
     */
    document: {
      findMany: async (query: DocumentsForUser) =>
        db.findManyDocuments(query.where.userId),
      findFirst: async (query: { where: DocumentWhere }) =>
        db.findDocument(query.where),
      create: async (query: { data: Document }) =>
        db.createDocument(query.data),
      deleteMany: async (query: { where: DocumentWhere }) =>
        db.deleteDocuments(query.where),
    },
    coverLetterInstructions: {
      findUnique: async (query: ByUserId) =>
        db.findCoverLetterInstructions(query.where.userId),
      upsert: async (query: UpsertCoverLetterInstructions) =>
        db.upsertCoverLetterInstructions(query),
    },
    /**
     * The whiteboard, which starts empty under the flag and stays wherever the
     * session leaves it. No fixture: a canned diagram is not what anyone is
     * checking on this page, and an empty canvas is the state the feature has
     * to work from anyway.
     */
    board: {
      findUnique: async (query: ByUserId) => db.findBoard(query.where.userId),
      upsert: async (query: UpsertBoard) => db.upsertBoard(query),
    },
    /**
     * Unreachable — `getCurrentUser()` returns before `ensureUserForAuth`.
     * Present so that moving that branch fails here, named, rather than as
     * "upsert is not a function".
     */
    user: {
      upsert: async () => {
        throw new DevPrismaError(
          "user.upsert",
          "Nothing should map an auth id onto a platform user under DEV_AUTH_BYPASS — the dev user's id is fixed in lib/dev/fixtures.ts."
        )
      },
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      db.executeRaw(strings, values),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      db.queryRaw(strings, values),
    $connect: async () => {},
    $disconnect: async () => {},
  }) as unknown as PrismaClient
}

/** `{ where: { id } }`, which is how every single-row lookup here is addressed. */
interface ById {
  where: { id: string }
}

/**
 * How the Documents table is addressed: by owner, and by owner plus id.
 *
 * **`userId` is not optional and must not become so.** It is the entire
 * ownership check on both `findDocument` and `deleteDocument` — there is no
 * second one underneath, the way `assertOwnedBy` sits under the object store.
 */
interface DocumentWhere {
  userId: string
  id?: string
}

interface DocumentsForUser {
  where: { userId: string }
  orderBy?: unknown
}

interface FindManyJobs {
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
}

/**
 * The whole of the row scoping the table applies, and the whole of what the
 * count is asked for.
 */
interface PostingsForUser {
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
interface FindManyPostings extends PostingsForUser {
  orderBy?: PostingOrderBy[]
  skip?: number
  take?: number
  select?: PostingSelect
}

/**
 * A `select` as this fake reads it: `true` for a column of `postings`, or a
 * nested `select` for one of its relations.
 */
type PostingSelect = Record<string, boolean | NestedSelect>

/** The relation half of a `select`, left `unknown` inside so it is checked. */
interface NestedSelect {
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

type SortDirection = "asc" | "desc"

interface NullableSort {
  sort: SortDirection
  nulls?: "first" | "last"
}

/** How the compound unique is addressed — the shape Prisma generates for it. */
interface ByUserAndPostingId {
  where: { userId_postingId: { userId: string; postingId: string } }
}

/** How the one row-per-user table is addressed: its owner *is* its primary key. */
interface ByUserId {
  where: { userId: string }
}

/**
 * Both columns are `@default("")` in the schema, so either half of the upsert
 * may leave either field out and get the empty string — matched here rather
 * than assumed, since a `create` that omitted one would otherwise write
 * `undefined` into a column typed `string`.
 */
type CoverLetterInstructionsValues = Partial<
  Pick<CoverLetterInstructions, "instructions" | "exampleLetter">
>

interface UpsertCoverLetterInstructions extends ByUserId {
  create: { userId: string } & CoverLetterInstructionsValues
  update: CoverLetterInstructionsValues
}

interface UpsertBoard extends ByUserId {
  create: { userId: string; snapshot: unknown }
  update: { snapshot: unknown }
}

type JobCreateData = Omit<Job, "id" | "createdAt" | "updatedAt">

/** What `startAdHocRun()` inserts — everything else takes a column default. */
type RunCreateData = Pick<Run, "jobId" | "scheduledFor" | "status">

/** What `runningRunForJob()` asks for. */
interface RunningRunQuery {
  where: {
    jobId: string
    status: string
    startedAt: { gte: Date }
  }
  orderBy?: unknown
}

/** The rows, and the only place under the flag that holds any state. */
class DevDb {
  private readonly jobs: Job[] = devJobs()
  private readonly runs: Run[] = devRuns()
  private readonly coverLetterInstructions: CoverLetterInstructions[] =
    devCoverLetterInstructions()
  private readonly postings: Posting[] = devPostings()
  private readonly documents: Document[] = devDocuments()
  /** No fixture — the dev whiteboard starts empty. See the accessor above. */
  private board: Board | undefined
  private nextId = 1

  /**
   * One user's Documents, newest first.
   *
   * The order is the real query's, restated rather than ignored: it is the
   * only order the list has, and `loadCandidateBackground` picks "the newest
   * document labelled resume" by taking the first match out of it. A fake that
   * answered in insertion order would make that choice look arbitrary here and
   * correct in production.
   */
  findManyDocuments(userId: string): Document[] {
    return this.documents
      .filter((document) => document.userId === userId)
      .sort(
        (left, right) =>
          right.uploadedAt.getTime() - left.uploadedAt.getTime() ||
          right.id.localeCompare(left.id)
      )
  }

  findDocument(where: DocumentWhere): Document | null {
    return (
      this.documents.find(
        (document) =>
          document.userId === where.userId &&
          (where.id === undefined || document.id === where.id)
      ) ?? null
    )
  }

  createDocument(data: Document): Document {
    const row: Document = { ...data, uploadedAt: data.uploadedAt ?? new Date() }

    this.documents.push(row)

    return row
  }

  /**
   * Splices out of the backing array rather than rebuilding it, for the reason
   * {@link deletePostings} gives: the field is `readonly` and every other
   * method reads through it.
   */
  deleteDocuments(where: DocumentWhere): { count: number } {
    let removed = 0

    for (let index = this.documents.length - 1; index >= 0; index -= 1) {
      const row = this.documents[index]

      if (
        row &&
        row.userId === where.userId &&
        (where.id === undefined || row.id === where.id)
      ) {
        this.documents.splice(index, 1)
        removed += 1
      }
    }

    return { count: removed }
  }

  /**
   * The whole rows, which is the only shape the dashboard asks for — both call
   * sites (`/jobs` and the settings section) select nothing.
   *
   * It used to answer a second shape too, `select: { runs: … }`, for the
   * deleted `lib/briefings/latest-postings.ts`, which read one Run's findings
   * to build the page. Nothing asks that now, so the branch is gone rather than
   * left answering a question nobody puts — and if a caller starts asking
   * again, {@link guard} is not what catches it: `select` would be accepted and
   * silently ignored, so the branch has to come back with the caller.
   *
   * `orderBy` is not read; every call site wants `createdAt` descending, which
   * is what this returns. The one place this fake lies rather than throwing —
   * cheap to fix if that changes. {@link findManyPostings} is deliberately not
   * like this: its order is chosen from the URL, so ignoring it there would be
   * a wrong-order bug rather than a shortcut.
   */
  findManyJobs(query: FindManyJobs): Partial<Job>[] {
    const found = this.jobs
      .filter((job) => job.userId === query.where.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    const select = query.select
    if (!select) return found

    return found.map((job) => this.projectJob(job, select))
  }

  /**
   * A Job narrowed to the fields a `select` asked for.
   *
   * The same rule as {@link projectPosting}, minus the relation branch: jobs
   * are only ever selected by column here. An unknown field throws by name
   * rather than answering `undefined`, so a select this fake cannot serve fails
   * loudly under `DEV_AUTH_BYPASS` instead of rendering a blank.
   */
  private projectJob(job: Job, select: Record<string, boolean>): Partial<Job> {
    const projected: Record<string, unknown> = {}

    for (const [field, wanted] of Object.entries(select)) {
      if (!wanted) continue

      if (!(field in job)) {
        throw new DevPrismaError(
          `prisma.job.findMany select.${field}`,
          "That column is not on a Job. Add it to lib/dev/fixtures.ts, or fix the select in app/(app)/jobs/page.tsx."
        )
      }

      projected[field] = job[field as keyof Job]
    }

    return projected as Partial<Job>
  }

  countPostings(where: PostingWhere): number {
    return this.matching(where).length
  }

  /**
   * ⚠️ **`orderBy` is honoured here, unlike in {@link findManyJobs}.**
   *
   * That one may ignore it because every caller wants the same order. This one
   * may not: the columns are sortable, the order is chosen from the URL, and a
   * fake that ignored it would render the table in one fixed order under
   * `DEV_AUTH_BYPASS` — silently, correctly-looking, and wrong — in exactly the
   * environment the table is built in. `skip` and `take` are honoured for the
   * same reason: paging that did nothing would make every page identical.
   *
   * ⚠️ **`select` is honoured too, relations included** — see
   * {@link projectPosting}. It was ignored until the table started asking which
   * Briefing found a Posting, at which point ignoring it stopped being a
   * harmless superset and became a blank in the dialog.
   */
  findManyPostings(query: FindManyPostings): unknown[] {
    const ordered = sortPostings(
      this.matching(query.where),
      query.orderBy ?? []
    )
    const from = query.skip ?? 0

    const page = ordered.slice(
      from,
      query.take === undefined ? undefined : from + query.take
    )

    const select = query.select
    if (select === undefined) return page

    return page.map((row) => this.projectPosting(row, select))
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
   * {@link findManyPostings} answers those with whole rows, which is what
   * Prisma does too.
   */
  private projectPosting(
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
        projected[field] = { job: { name: this.briefingThatFound(row) } }
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
   * {@link devPostings} derives its ids rather than writing them out: a name
   * copied onto a Posting could disagree with the Briefing that fixture claims
   * to have come from, and disagree silently.
   *
   * ⚠️ **A dangling reference throws.** Both foreign keys are NOT NULL with
   * `ON DELETE RESTRICT`, so this is not a state the page has to survive — it
   * is a fixture that has drifted, and it should say so by name here rather
   * than reach `list-postings.ts` as an unnamed Briefing.
   */
  private briefingThatFound(row: Posting): string {
    const run = this.runs.find(
      (candidate) => candidate.id === row.lastSeenRunId
    )
    const job = run ? this.findJob(run.jobId) : null

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
  findPosting(key: { userId: string; postingId: string }): Posting | null {
    return (
      this.postings.find(
        (row) => row.userId === key.userId && row.postingId === key.postingId
      ) ?? null
    )
  }

  /**
   * The row count as the answer, which is how `setPostingStatus()` distinguishes
   * "no such Posting for this user" from a write it made.
   */
  updatePostings(
    where: { userId: string; postingId: string },
    data: Partial<Posting>
  ): { count: number } {
    const row = this.findPosting(where)
    if (!row) return { count: 0 }

    Object.assign(row, data)
    return { count: 1 }
  }

  /**
   * The row count as the answer, which is how `deletePostings()` in
   * `@workspace/db` reports how many Postings actually went.
   *
   * Splices out of the backing array rather than rebuilding it, because
   * {@link postings} is `readonly` and every other method reads through it —
   * a reassignment would leave `findPosting` looking at the old rows.
   */
  deletePostings(where: PostingWhere): { count: number } {
    return { count: removeMatchingPostings(this.postings, where).length }
  }

  private matching(where: PostingWhere): Posting[] {
    return this.postings.filter((row) => matchesPostingWhere(row, where))
  }

  findJob(id: string): Job | null {
    return this.jobs.find((job) => job.id === id) ?? null
  }

  /** The trigger's one-run-at-a-time guard, filtering for real. */
  findRunningRun(query: RunningRunQuery): Run | null {
    const { jobId, status, startedAt } = query.where

    return (
      this.runs
        .filter(
          (run) =>
            run.jobId === jobId &&
            run.status === status &&
            run.startedAt.getTime() >= startedAt.gte.getTime()
        )
        .sort(byStartedAtThenIdDesc)[0] ?? null
    )
  }

  createRun(data: RunCreateData): Run {
    const run: Run = {
      ...data,
      id: `3f8d1b2a-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
      startedAt: new Date(),
      claimedAt: null,
      finishedAt: null,
      failure: null,
      findings: null,
    }

    this.runs.push(run)
    return run
  }

  updateRun(id: string, data: Partial<Run>): Run {
    const run = this.runs.find((candidate) => candidate.id === id)
    if (!run) throw notFound()

    Object.assign(run, data)
    return run
  }

  /**
   * `updateMany` with the row count as the answer — the shape `finishRun()` and
   * `failRun()` use to make a transition at-most-once. The `status` in the
   * `where` is the guard, so honouring it is what keeps a terminal run
   * terminal here too.
   */
  updateRunsGuarded(
    where: { id: string; status?: string },
    data: Partial<Run>
  ): { count: number } {
    const run = this.runs.find(
      (candidate) =>
        candidate.id === where.id &&
        (where.status === undefined || candidate.status === where.status)
    )

    if (!run) return { count: 0 }

    Object.assign(run, data)
    return { count: 1 }
  }

  createJob(data: JobCreateData): Job {
    const now = new Date()
    const job: Job = {
      ...data,
      id: `3f8d1b2a-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
      createdAt: now,
      updatedAt: now,
    }

    this.jobs.push(job)
    return job
  }

  updateJob(id: string, data: Partial<Job>): Job {
    const job = this.findJob(id)

    // P2025 is the code `pauseJob()` in packages/db/src/jobs.ts catches to
    // return undefined for a row that is gone. A plain Error would propagate
    // past it and surface as "Something went wrong" instead of "not found".
    if (!job) throw notFound()

    Object.assign(job, data, { updatedAt: new Date() })
    return job
  }

  /**
   * `null`, not an empty row, for a user who has never saved: the caller draws
   * a distinction between "no preference was ever expressed" and "it was, and
   * it is empty", and answering `{ instructions: "" }` here would erase it.
   */
  findCoverLetterInstructions(userId: string): CoverLetterInstructions | null {
    return (
      this.coverLetterInstructions.find((row) => row.userId === userId) ?? null
    )
  }

  /**
   * Create and update in the one call, as Prisma does — and the created row
   * lives in the same array as the fixture, so the save survives the redirect
   * after it and a restart puts the fixture back.
   */
  upsertCoverLetterInstructions(
    query: UpsertCoverLetterInstructions
  ): CoverLetterInstructions {
    const { userId } = query.where
    const existing = this.findCoverLetterInstructions(userId)
    const written = existing ? query.update : query.create

    const row: CoverLetterInstructions = {
      userId,
      instructions: written.instructions ?? existing?.instructions ?? "",
      exampleLetter: written.exampleLetter ?? existing?.exampleLetter ?? "",
      updatedAt: new Date(),
    }

    if (existing) return Object.assign(existing, row)

    this.coverLetterInstructions.push(row)
    return row
  }

  findBoard(userId: string): Board | null {
    return this.board?.userId === userId ? this.board : null
  }

  /**
   * Replaces the snapshot whole, as the real upsert does. A board is a picture
   * rather than a patch of one, so there is nothing to merge.
   */
  upsertBoard(query: UpsertBoard): Board {
    const { userId } = query.where
    const snapshot = this.findBoard(userId)
      ? query.update.snapshot
      : query.create.snapshot

    this.board = {
      userId,
      snapshot: snapshot as Board["snapshot"],
      updatedAt: new Date(),
    }
    return this.board
  }

  /**
   * ⚠️ **`updateJobSchedule()` is raw SQL, not `job.update`** — it needs a
   * `CASE` to leave a paused briefing paused — so the schedule form lands here
   * and its four values are matched by position.
   *
   * Fragile, so it is checked rather than assumed: anything that is not an
   * `UPDATE jobs` with four values throws, naming the file to look at.
   */
  executeRaw(strings: TemplateStringsArray, values: unknown[]): number {
    const sql = strings.join("?")

    if (!/update\s+jobs/i.test(sql) || values.length !== 4) {
      throw new DevPrismaError(
        "$executeRaw",
        `Only the UPDATE in updateJobSchedule() is understood, and it is ` +
          `matched by position. If packages/db/src/jobs.ts changed its ` +
          `statement, update executeRaw() in this file to match. Got: ${sql}`
      )
    }

    const [cron, timezone, nextRunAt, id] = values as [
      string,
      string,
      Date,
      string,
    ]

    const job = this.findJob(id)
    if (!job) return 0

    job.scheduleCron = cron
    job.scheduleTimezone = timezone
    // The `CASE` in the real statement: a paused briefing stays paused.
    job.nextRunAt = job.nextRunAt === null ? null : nextRunAt
    job.updatedAt = new Date()

    return 1
  }

  /**
   * ⚠️ **`latestRunPerJob()` is raw SQL, not `run.findMany`** — it needs
   * `DISTINCT ON`, which Prisma's model API cannot express — so the briefings
   * page lands here.
   *
   * Recognised by shape rather than parsed, exactly as {@link executeRaw} is,
   * and it throws on anything else so a changed statement fails by name instead
   * of silently returning nothing and rendering an empty page.
   */
  queryRaw(strings: TemplateStringsArray, values: unknown[]): unknown[] {
    const sql = strings.join("?")

    if (
      !/distinct\s+on\s*\(\s*r\.job_id\s*\)/i.test(sql) ||
      values.length !== 1
    ) {
      throw new DevPrismaError(
        "$queryRaw",
        `Only the DISTINCT ON in latestRunPerJob() is understood, and it is ` +
          `matched by shape. If packages/db/src/runs.ts changed its ` +
          `statement, update queryRaw() in this file to match. Got: ${sql}`
      )
    }

    const [userId] = values as [string]
    const mine = new Set(
      this.jobs.filter((job) => job.userId === userId).map((job) => job.id)
    )

    const newest = new Map<string, Run>()
    for (const run of [...this.runs].sort(byStartedAtThenIdDesc)) {
      if (mine.has(run.jobId) && !newest.has(run.jobId))
        newest.set(run.jobId, run)
    }

    return [...newest.values()].map((run) => ({
      id: run.id,
      jobId: run.jobId,
      status: run.status,
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      failure: run.failure,
    }))
  }
}

/** The two columns every Postings filter in this app is written against. */
interface PostingKey {
  userId: string
  postingId: string
}

/**
 * ⚠️ **Throws on a filter it does not understand, rather than ignoring it.**
 *
 * The whole file's principle, and nowhere does it matter more than here: this
 * predicate decides what `deleteMany` removes, so a clause quietly dropped
 * would not merely widen a listing — it would delete every Posting the dev user
 * has, in the one environment the delete is built in.
 *
 * Module-level and exported rather than a method, because
 * `lib/postings/posting-actions.test.ts` builds its own `posting` double and had
 * copied this rule out. Two spellings of "which rows does this `where` name" is
 * one more than the number that can be wrong without anyone noticing — sharing
 * the predicate is not code thrift, it is the only way a divergence shows up as
 * a failing test rather than as a fake that agrees with nothing.
 */
export function matchesPostingWhere(
  row: PostingKey,
  where: PostingWhere
): boolean {
  if (row.userId !== where.userId) return false

  const byId = where.postingId
  if (byId === undefined) return true

  if (!Array.isArray(byId.in)) {
    throw new DevPrismaError(
      "prisma.posting where.postingId",
      "The only filter understood here is `postingId: { in: [...] }`. Teach matchesPostingWhere() in this file the new shape — ignoring it would widen a delete to every posting the dev user has."
    )
  }

  return byId.in.includes(row.postingId)
}

/**
 * Delete in place and answer with the rows that went, in the order they sat in.
 *
 * Splices out of the caller's array rather than handing back a new one, because
 * every holder of a `posting` double keeps its rows in a `readonly` field that
 * the rest of the double reads through — a reassignment would leave the other
 * methods looking at rows that are supposed to be gone.
 */
export function removeMatchingPostings<Row extends PostingKey>(
  rows: Row[],
  where: PostingWhere
): Row[] {
  const removed: Row[] = []

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row !== undefined && matchesPostingWhere(row, where)) {
      rows.splice(index, 1)
      removed.push(row)
    }
  }

  return removed.reverse()
}

/**
 * Every `orderBy` clause applied in turn, first difference winning.
 *
 * The tie-break clause `list-postings.ts` appends is what makes a page boundary
 * stable, so it has to be applied here too — a fake that stopped at the first
 * clause would hide exactly the bug that tie-break exists to prevent.
 */
function sortPostings(rows: Posting[], orderBy: PostingOrderBy[]): Posting[] {
  return [...rows].sort((left, right) => {
    for (const clause of orderBy) {
      for (const [field, spec] of Object.entries(clause)) {
        const { sort: direction, nulls } =
          typeof spec === "string" ? { sort: spec, nulls: undefined } : spec

        const a = readPostingField(left, field)
        const b = readPostingField(right, field)

        // Nullity first, and outside the direction flip below — where a NULL
        // sits is decided by the clause, not by which way the values run.
        const byNullity = compareNullity(a, b, direction, nulls)
        if (byNullity !== undefined) {
          if (byNullity !== 0) return byNullity
          continue
        }

        const compared = comparePostingValues(field, a, b)
        if (compared !== 0) return direction === "desc" ? -compared : compared
      }
    }

    return 0
  })
}

/**
 * Throws on a field that is not a column, rather than answering `undefined`.
 *
 * The whole file's principle, applied to the one place where the alternative is
 * invisible: a comparator that shrugged would leave the rows in insertion order
 * and look like a table that had been sorted.
 */
function readPostingField(row: Posting, field: string): unknown {
  if (!(field in row)) {
    throw new DevPrismaError(
      `prisma.posting.findMany orderBy.${field}`,
      "That column is not on a Posting. Add it to lib/dev/fixtures.ts, or fix the orderBy in lib/postings/list-postings.ts."
    )
  }

  return row[field as keyof Posting]
}

/**
 * Where a NULL sits, or `undefined` when both sides have a value and the values
 * themselves decide.
 *
 * ⚠️ **The default depends on the direction, because Postgres's does**: NULLS
 * LAST under `ASC` and NULLS FIRST under `DESC`. Defaulting to "last" both ways
 * would be the friendlier rule and would make this fake disagree with the
 * database it stands in for — which is the one thing it must not do.
 * `list-postings.ts` pins `nulls: "last"` on the Posted column precisely so
 * that the direction stops deciding it.
 *
 * Exported so `list-postings.test.ts`'s own `FakeDb` — a narrower double that
 * simulates only the query shapes `listPostings()` sends, rather than the
 * whole of `prisma.posting` this file stands in for — applies the identical
 * rule instead of restating it, the same way `posting-actions.test.ts` already
 * reuses {@link matchesPostingWhere} and {@link removeMatchingPostings} from
 * here rather than reimplementing them.
 */
export function compareNullity(
  a: unknown,
  b: unknown,
  direction: SortDirection,
  nulls: "first" | "last" | undefined
): number | undefined {
  const aEmpty = a === null || a === undefined
  const bEmpty = b === null || b === undefined

  if (!aEmpty && !bEmpty) return undefined
  if (aEmpty && bEmpty) return 0

  const last = nulls === undefined ? direction === "asc" : nulls === "last"

  return (aEmpty ? 1 : -1) * (last ? 1 : -1)
}

/**
 * Two present values of a column, compared in ascending order.
 *
 * Exported alongside {@link compareNullity} so `list-postings.test.ts`'s
 * `FakeDb` shares this half of the sort rule too, rather than a second inline
 * comparator that could silently fall back to comparing something neither a
 * `Date` nor a `string` — which this one refuses, on the file's own principle
 * that an unimplemented case should throw rather than answer `undefined`.
 */
export function comparePostingValues(
  field: string,
  a: unknown,
  b: unknown
): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b)

  throw new DevPrismaError(
    `prisma.posting.findMany orderBy.${field}`,
    `Only text and timestamp columns can be ordered by here, and ${field} is neither.`
  )
}

/**
 * Exactly `{ select: { job: { select: { name: true } } } }`, and nothing wider.
 *
 * Matched by shape rather than merely by the key `lastSeenRun`, in the spirit of
 * {@link DevDb.executeRaw}: a caller that starts asking the relation for a
 * second field gets a named refusal here, instead of a row missing whichever
 * field this fake never learned to fill in.
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

function byStartedAtThenIdDesc(a: Run, b: Run): number {
  const byTime = b.startedAt.getTime() - a.startedAt.getTime()
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
}

function notFound(): Error & { code: string } {
  return Object.assign(new Error("Record to update not found."), {
    code: "P2025",
  })
}

class DevPrismaError extends Error {
  constructor(operation: string, detail: string) {
    super(
      `The DEV_AUTH_BYPASS fake database does not implement ${operation}. ${detail}`
    )
    this.name = "DevPrismaError"
  }
}

/**
 * Let through as `undefined`: `await` inspects `.then`, and throwing on that
 * would break every supported call on its way to succeeding.
 */
const PASS_THROUGH = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "constructor",
  "$on",
  "$extends",
  "$transaction",
])

/**
 * Applied to the models as well as the client: `prisma.job` exists, so the
 * likelier mistake is a missing *method* on a model that is present.
 */
function guard(
  target: Record<string, unknown>,
  path: string = "prisma"
): object {
  const guarded: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(target)) {
    guarded[key] =
      isPlainObject(value) && !key.startsWith("$")
        ? guard(value, `${path}.${key}`)
        : value
  }

  return new Proxy(guarded, {
    get(model, property) {
      if (typeof property === "symbol" || PASS_THROUGH.has(property)) {
        return Reflect.get(model, property)
      }

      if (!(property in model)) {
        throw new DevPrismaError(
          `${path}.${property}`,
          "Add it to lib/dev/fake-prisma.ts, or the page that needs it will only work against a real database."
        )
      }

      return Reflect.get(model, property)
    },
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && value.constructor === Object
  )
}
