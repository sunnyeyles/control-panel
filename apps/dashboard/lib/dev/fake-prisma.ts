import { devJobs, devRuns } from "@/lib/dev/fixtures"
import type { Job, PrismaClient, Run } from "@workspace/db"

/**
 * Postgres, for `DEV_AUTH_BYPASS=1` only — an in-memory stand-in that honours
 * the queries this app actually makes and refuses every other one by name.
 *
 * **It filters and orders for real rather than returning canned rows.** A fake
 * that ignored `where` would still make the pages look right, and would quietly
 * stop the user-scoping in `latest-postings.ts` and `job-actions.ts` from being
 * visible while someone edits around it. The same reasoning is written out at
 * `lib/briefings/latest-postings.test.ts`, whose `FakeDb` this follows.
 *
 * **Writes are kept, and only for the life of the process.** Pausing a briefing
 * or saving a new interval has to survive the redirect that follows it, or the
 * form appears not to work; it does not have to survive a restart, and a
 * restart putting the fixtures back is the useful behaviour rather than a
 * limitation.
 *
 * ⚠️ **Unsupported calls throw.** Prisma's client is a `Proxy` over the whole
 * schema, so a fake that answered anything would answer `artifact.findMany()`
 * with `undefined` and surface as a null dereference three frames away. Every
 * model and method not implemented below raises an error that names what was
 * asked for, so adding a query to the dashboard fails here, loudly, with the
 * fix in the message.
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
    },
    /**
     * Unreachable under the flag — `getCurrentUser()` returns the fixed dev
     * user before it can call `ensureUserForAuth`. Implemented anyway so that
     * if that branch is ever moved, this fails as a wrong answer rather than as
     * "user.upsert is not a function", which reads like a Prisma problem.
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

/** The rows, and the only place under the flag that holds any state. */
class DevDb {
  private readonly jobs: Job[] = devJobs()
  private readonly runs: Run[] = devRuns()
  private nextId = 1

  /**
   * Both shapes the dashboard asks for, discriminated by `select.runs` rather
   * than by a flag from the caller — the callers are `latest-postings.ts` and
   * `briefing-section.tsx`, neither of which knows it is talking to a fake.
   *
   * `orderBy` is not read: every call site here orders by `createdAt`
   * descending, so that is simply what is applied. A caller wanting another
   * order would silently get this one, which is the one piece of this fake that
   * lies rather than throwing — cheap to fix if a second order ever appears.
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
   * Returned with its `job` relation attached, because the only caller selects
   * it — `cover-letter-actions.ts` loads the owning Job to compare its
   * `userId` to the caller's, deliberately rather than folding the check into
   * the query. Dropping the relation here would make that comparison read
   * `undefined.userId`.
   */
  findRun(id: string): (Run & { job: { userId: string } }) | null {
    const run = this.runs.find((candidate) => candidate.id === id)
    if (!run) return null

    const job = this.findJob(run.jobId)
    if (!job) return null

    return { ...run, job: { userId: job.userId } }
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
   * ⚠️ **`updateJobSchedule()` is raw SQL, not `job.update`,** because it needs
   * a `CASE` to leave a paused briefing paused. So the schedule form reaches
   * this method rather than {@link updateJob}, and the four interpolated values
   * are matched by position.
   *
   * That coupling is checked rather than assumed: the statement must still be
   * an `UPDATE jobs` carrying exactly four values, and anything else throws
   * naming the file to look at. Positional matching is fragile — being loud
   * about it is what makes it survivable.
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
 * Names the missing query instead of returning `undefined` for it.
 *
 * Symbols and the handful of names a promise or a logger reaches for are let
 * through as `undefined` — `await client.job.findMany()` inspects `.then` on
 * the result, and a proxy that threw on that would break every supported call
 * on its way to succeeding.
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
 * Applied to the models as well as the client, because the gap it closes is one
 * level down: `prisma.job` exists, and without this `prisma.job.deleteMany`
 * would be `undefined` — a missing *method* on a model present is the likelier
 * mistake by far, since the four models here already cover the schema the
 * dashboard touches.
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
