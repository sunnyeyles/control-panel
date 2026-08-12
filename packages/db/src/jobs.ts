import type { Prisma, PrismaClient } from "./generated/prisma/client.ts"
import type { Job, JobConfig } from "./types.ts"
import { computeNextRunAt } from "./schedule.ts"

/** A job on its way in. */
export interface NewJob {
  userId: string
  /** Unique per user, which is also what makes a seed re-runnable. */
  name: string
  /** Pipeline-interpreted. Defaults to `{}`. */
  config?: JobConfig
  scheduleCron: string
  /** An IANA zone name. Defaults to `UTC`. */
  scheduleTimezone?: string
}

/** What a successful claim returns. */
export interface ClaimedSlot {
  /** The run row created by the claim, already `running`. */
  runId: string
  /** The occurrence claimed — the `next_run_at` value that was observed. */
  scheduledFor: Date
  /** Where the job's `next_run_at` was advanced to. */
  nextRunAt: Date
}

/**
 * A job the tick has selected, narrowed so `nextRunAt` is known present.
 *
 * `claimJob()` takes this rather than a `Job` because the value it advances
 * *from* is the occurrence it claims — a claim without one is not expressible.
 */
export type DueJob = Job & { nextRunAt: Date }

/** How many due jobs one tick will look at unless told otherwise. */
const DEFAULT_DUE_LIMIT = 50

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * One job by its id, or `undefined` when there is no such row.
 *
 * ⚠️ **This does not filter by `user_id`, and no helper in this file does.** A
 * `jobs.id` addresses any row, which is right for the worker's tick and exactly
 * wrong for a `jobId` arriving from a form — **a caller acting for a user must
 * check ownership itself**, via the dashboard's `requireOwnedJob`.
 *
 * `undefined` rather than Prisma's `null`, matching {@link pauseJob} and
 * {@link resumeJob}, so a caller has one absent value rather than two.
 */
export async function findJob(
  prisma: DbClient,
  id: string
): Promise<Job | undefined> {
  return (await prisma.job.findUnique({ where: { id } })) ?? undefined
}

/** Create a scheduled job, computing `nextRunAt` before the insert. */
export async function createJob(
  prisma: DbClient,
  job: NewJob,
  now: Date = new Date()
): Promise<Job> {
  const timezone = job.scheduleTimezone ?? "UTC"
  const nextRunAt = computeNextRunAt(job.scheduleCron, timezone, now)

  return prisma.job.create({
    data: {
      userId: job.userId,
      name: job.name,
      config: (job.config ?? {}) as Prisma.InputJsonValue,
      scheduleCron: job.scheduleCron,
      scheduleTimezone: timezone,
      nextRunAt,
    },
  })
}

/**
 * Jobs whose slot has arrived, oldest first.
 *
 * `nextRunAt is not null` is stated even though `lte` already excludes NULL,
 * because it is the predicate of `jobs_next_run_at_idx`.
 */
export async function dueJobs(
  prisma: DbClient,
  now: Date = new Date(),
  limit: number = DEFAULT_DUE_LIMIT
): Promise<DueJob[]> {
  const rows = await prisma.job.findMany({
    where: {
      nextRunAt: { not: null, lte: now },
    },
    orderBy: { nextRunAt: "asc" },
    take: limit,
  })

  return rows.map(toDueJob)
}

/**
 * Take the slot, or find out someone else has it.
 *
 * Returns `undefined` when the job was already claimed. **The caller must then
 * skip the job entirely**: not run it, not retry it, not touch the row.
 *
 * At-most-once, and deliberately so — every duplicate occurrence is a paid LLM
 * run. The partial unique index conflict target cannot be expressed in Prisma's
 * model API, so the insert is raw SQL inside the same interactive transaction.
 */
export async function claimJob(
  prisma: PrismaClient,
  job: DueJob,
  now: Date = new Date()
): Promise<ClaimedSlot | undefined> {
  const fromNow = computeNextRunAt(job.scheduleCron, job.scheduleTimezone, now)

  // A claim must always move the slot forward. Computing from `now` alone can
  // reproduce the observed slot when claiming early; advance from the slot in
  // that case so the guarded UPDATE never writes the value it matched on.
  const nextRunAt =
    fromNow > job.nextRunAt
      ? fromNow
      : computeNextRunAt(job.scheduleCron, job.scheduleTimezone, job.nextRunAt)

  return prisma.$transaction(async (tx) => {
    const advanced = await tx.job.updateMany({
      where: { id: job.id, nextRunAt: job.nextRunAt },
      data: { nextRunAt },
    })

    if (advanced.count === 0) return undefined

    // `WHERE scheduled_for IS NOT NULL` is not optional: ON CONFLICT infers the
    // partial index from it, and without it the statement errors.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO runs (job_id, scheduled_for, status)
      VALUES (${job.id}::uuid, ${job.nextRunAt}, 'running')
      ON CONFLICT (job_id, scheduled_for) WHERE scheduled_for IS NOT NULL
      DO NOTHING
      RETURNING id
    `

    const run = inserted[0]
    if (!run) return undefined

    return { runId: run.id, scheduledFor: job.nextRunAt, nextRunAt }
  })
}

/**
 * Change the cadence, recomputing `next_run_at` in the same statement.
 *
 * A paused job (`nextRunAt IS NULL`) stays paused — writing the new occurrence
 * unconditionally would put a retired job back on duty as a side effect of
 * tidying its cron.
 */
export async function updateJobSchedule(
  prisma: DbClient,
  id: string,
  schedule: { cron: string; timezone?: string },
  now: Date = new Date()
): Promise<Job | undefined> {
  const timezone = schedule.timezone ?? "UTC"
  const nextRunAt = computeNextRunAt(schedule.cron, timezone, now)

  const updated = await prisma.$executeRaw`
    UPDATE jobs
    SET schedule_cron = ${schedule.cron},
        schedule_timezone = ${timezone},
        next_run_at = CASE
          WHEN next_run_at IS NULL THEN NULL
          ELSE ${nextRunAt}::timestamptz
        END,
        updated_at = now()
    WHERE id = ${id}::uuid
  `

  if (updated === 0) return undefined

  return findJob(prisma, id)
}

/**
 * Replace a job's `config`, leaving its cadence and its name alone.
 *
 * **A replacement rather than a patch**, in the same spirit as
 * `savePostingFilters`: what arrives is the config, not a change to it. A merge
 * would make removing a field impossible to express through this function,
 * which is the operation an edit form performs most often — dropping the third
 * role title is exactly a config with one fewer entry.
 *
 * ⚠️ **`config` is opaque here and must stay that way.** `@workspace/db` stores
 * the column and never reads inside it, so the interpretation belongs to
 * whatever runs the job — `JobSearchConfigSchema` in `@workspace/job-search`
 * today, and something else entirely for a second kind of job later. Validating
 * against a job-search shape in this function would be the migration that
 * package exists to avoid.
 *
 * Ownership is the caller's, as it is for every helper in this file: a
 * `jobs.id` addresses any row in the table, and {@link findJob}'s docblock sets
 * out why the check lives in the dashboard's `requireOwnedJob` instead.
 *
 * `next_run_at` is untouched, so a paused briefing stays paused and a scheduled
 * one keeps the occurrence it was already waiting for — editing what a briefing
 * searches for is not a reason to move when it next runs.
 */
export async function updateJobConfig(
  prisma: DbClient,
  id: string,
  config: JobConfig
): Promise<Job | undefined> {
  try {
    return await prisma.job.update({
      where: { id },
      data: { config: config as Prisma.InputJsonValue },
    })
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** Take a job off duty — `next_run_at = NULL`. */
export async function pauseJob(
  prisma: DbClient,
  id: string
): Promise<Job | undefined> {
  try {
    return await prisma.job.update({
      where: { id },
      data: { nextRunAt: null },
    })
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** Put it back on, at its next occurrence rather than the one it missed. */
export async function resumeJob(
  prisma: DbClient,
  id: string,
  now: Date = new Date()
): Promise<Job | undefined> {
  const job = await findJob(prisma, id)
  if (!job) return undefined

  const nextRunAt = computeNextRunAt(
    job.scheduleCron,
    job.scheduleTimezone,
    now
  )

  return prisma.job.update({
    where: { id },
    data: { nextRunAt },
  })
}

function toDueJob(job: Job): DueJob {
  if (!job.nextRunAt) {
    throw new Error(
      `Job ${job.id} came back from a due query with no nextRunAt, which the query's own WHERE clause forbids.`
    )
  }

  return { ...job, nextRunAt: job.nextRunAt }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2025"
  )
}
