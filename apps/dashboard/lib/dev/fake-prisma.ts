import {
  devCoverLetterInstructions,
  devJobs,
  devPostings,
  devRuns,
} from "@/lib/dev/fixtures"
import type {
  CoverLetterInstructions,
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
     * **order and page for real** — see {@link DevDb.findManyPostings}.
     */
    posting: {
      count: async (query: PostingsForUser) => db.countPostings(query.where),
      findMany: async (query: FindManyPostings) => db.findManyPostings(query),
      findUnique: async (query: ByUserAndPostingId) =>
        db.findPosting(query.where.userId_postingId),
      updateMany: async (query: {
        where: { userId: string; postingId: string }
        data: Partial<Posting>
      }) => db.updatePostings(query.where, query.data),
    },
    coverLetterInstructions: {
      findUnique: async (query: ByUserId) =>
        db.findCoverLetterInstructions(query.where.userId),
      upsert: async (query: UpsertCoverLetterInstructions) =>
        db.upsertCoverLetterInstructions(query),
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

interface FindManyJobs {
  where: { userId: string }
  orderBy?: unknown
}

/**
 * The whole of the row scoping the table applies, and the whole of what the
 * count is asked for. A Posting is not addressable without naming a user.
 */
interface PostingsForUser {
  where: { userId: string }
}

/**
 * What `listPostings()` asks for.
 *
 * `select` is accepted and deliberately **not** applied: the fake answers with
 * the whole row, which is a superset of what was asked for, and a caller that
 * reads only the fields it selected cannot tell the difference. Ordering and
 * paging are a different matter — those change *which* rows come back, so they
 * are honoured exactly.
 */
interface FindManyPostings extends PostingsForUser {
  orderBy?: PostingOrderBy[]
  skip?: number
  take?: number
  select?: Record<string, boolean>
}

/** One `{ field: direction }` clause, as Prisma spells it. */
type PostingOrderBy = Record<string, "asc" | "desc">

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
  private nextId = 1

  /**
   * The whole rows, which is the only shape the dashboard asks for — both call
   * sites (`/briefings` and the settings section) select nothing.
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
  findManyJobs(query: FindManyJobs): Job[] {
    return this.jobs
      .filter((job) => job.userId === query.where.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  countPostings(where: { userId: string }): number {
    return this.mine(where.userId).length
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
   */
  findManyPostings(query: FindManyPostings): Posting[] {
    const ordered = sortPostings(
      this.mine(query.where.userId),
      query.orderBy ?? []
    )
    const from = query.skip ?? 0

    return ordered.slice(
      from,
      query.take === undefined ? undefined : from + query.take
    )
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

  private mine(userId: string): Posting[] {
    return this.postings.filter((row) => row.userId === userId)
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
      for (const [field, direction] of Object.entries(clause)) {
        const compared = comparePostingField(left, right, field)
        if (compared !== 0) return direction === "desc" ? -compared : compared
      }
    }

    return 0
  })
}

/**
 * Throws on a field it cannot order by, rather than answering `0`.
 *
 * The whole file's principle, applied to the one place where the alternative is
 * invisible: a comparator that shrugged would leave the rows in insertion order
 * and look like a table that had been sorted.
 */
function comparePostingField(
  left: Posting,
  right: Posting,
  field: string
): number {
  if (!(field in left)) {
    throw new DevPrismaError(
      `prisma.posting.findMany orderBy.${field}`,
      "That column is not on a Posting. Add it to lib/dev/fixtures.ts, or fix the orderBy in lib/postings/list-postings.ts."
    )
  }

  const a = left[field as keyof Posting]
  const b = right[field as keyof Posting]

  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b)

  throw new DevPrismaError(
    `prisma.posting.findMany orderBy.${field}`,
    `Only text and timestamp columns can be ordered by here, and ${field} is neither.`
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
