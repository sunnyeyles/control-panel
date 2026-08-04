import { devJobs, devRuns } from "@/lib/dev/fixtures"
import type { Job, PrismaClient, Run } from "@workspace/db"

/**
 * Postgres, for `DEV_AUTH_BYPASS=1` only — an in-memory stand-in that honours
 * the queries this app makes and refuses every other one by name.
 *
 * **It filters and orders for real rather than returning canned rows**, so the
 * user-scoping in `latest-postings.ts` and `job-actions.ts` stays visible to
 * anyone editing around it. Follows the `FakeDb` in
 * `lib/briefings/latest-postings.test.ts`.
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
      findUnique: async (query: ById) => db.findRun(query.where.id),
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
  select?: {
    runs?: {
      where: { status: string }
      take?: number
    }
  }
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
  private nextId = 1

  /**
   * Both shapes the dashboard asks for, discriminated by `select.runs` — the
   * callers do not know they are talking to a fake.
   *
   * `orderBy` is not read; every call site wants `createdAt` descending. The one
   * place this fake lies rather than throwing — cheap to fix if that changes.
   */
  findManyJobs(query: FindManyJobs): unknown[] {
    const mine = this.jobs
      .filter((job) => job.userId === query.where.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    const runsSelect = query.select?.runs
    if (!runsSelect) return mine

    return mine.map((job) => ({
      id: job.id,
      name: job.name,
      runs: this.runs
        .filter(
          (run) =>
            run.jobId === job.id && run.status === runsSelect.where.status
        )
        .sort(byStartedAtThenIdDesc)
        .slice(0, runsSelect.take ?? this.runs.length)
        .map((run) => ({
          id: run.id,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          findings: run.findings,
        })),
    }))
  }

  findJob(id: string): Job | null {
    return this.jobs.find((job) => job.id === id) ?? null
  }

  /**
   * With its `job` relation attached: `cover-letter-actions.ts` compares the
   * owning Job's `userId` to the caller's, so dropping it would make that
   * comparison read `undefined.userId`.
   */
  findRun(id: string): (Run & { job: { userId: string } }) | null {
    const run = this.runs.find((candidate) => candidate.id === id)
    if (!run) return null

    const job = this.findJob(run.jobId)
    if (!job) return null

    return { ...run, job: { userId: job.userId } }
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
