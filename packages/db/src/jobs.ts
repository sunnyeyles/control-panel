import type { Connection } from "./client.js"
import type { DueJob, Job, JobConfig } from "./rows.js"
import { computeNextRunAt } from "./schedule.js"

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
 * Jobs, and the claim.
 *
 * A narrow facade rather than a query surface: callers express intent and never
 * SQL. That is not style — the claim's `ON CONFLICT … WHERE` predicate and the
 * conditional `UPDATE`'s guard are both trivially omitted at a call site and
 * neither is reachable from one.
 */
export interface JobStore {
  create(job: NewJob, now?: Date): Promise<Job>
  get(id: string): Promise<Job | undefined>
  /** Every job a user owns, including unscheduled ones, newest first. */
  listForUser(userId: string): Promise<Job[]>

  /**
   * What the hourly tick asks for: jobs whose slot has arrived.
   *
   * Ordered oldest-slot-first so a tick that cannot get through every due job
   * before the Lambda times out at least works through the backlog in order.
   */
  dueJobs(now?: Date, limit?: number): Promise<DueJob[]>

  /**
   * Take the slot, or find out someone else has it.
   *
   * Returns `undefined` when the job was already claimed — by an overlapping
   * tick, a manual invoke landing mid-tick, or an operator resetting
   * `next_run_at` by hand. **The caller must then skip the job entirely**: not
   * run it, not retry it, not touch the row.
   *
   * At-most-once, and deliberately so — every duplicate occurrence is a paid
   * LLM run.
   */
  claim(job: DueJob, now?: Date): Promise<ClaimedSlot | undefined>

  /**
   * Change the cadence, recomputing `next_run_at` in the same statement.
   *
   * The same statement, never a follow-up write: a job whose cron was edited
   * but which silently keeps firing on the old schedule is the exact failure
   * this method exists to prevent, and a second round trip is a window where
   * that is true.
   */
  updateSchedule(
    id: string,
    schedule: { cron: string; timezone?: string },
    now?: Date
  ): Promise<Job | undefined>

  /** Take a job off duty — `next_run_at = NULL`. Retirement is the same act. */
  pause(id: string): Promise<Job | undefined>

  /** Put it back on, at its next occurrence rather than the one it missed. */
  resume(id: string, now?: Date): Promise<Job | undefined>
}

interface JobRow {
  id: string
  user_id: string
  name: string
  config: JobConfig
  schedule_cron: string
  schedule_timezone: string
  next_run_at: Date | null
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, user_id, name, config, schedule_cron, schedule_timezone,
                 next_run_at, created_at, updated_at`

/** How many due jobs one tick will look at unless told otherwise. */
const DEFAULT_DUE_LIMIT = 50

export function createJobStore(connection: Connection): JobStore {
  // Named, rather than returned as an anonymous literal, so `resume()` can
  // reach `store.get()` without `this` — a method that depends on its receiver
  // breaks the moment a caller destructures it off the store, which is an
  // ordinary thing to do with a facade.
  const store: JobStore = {
    async create(job: NewJob, now: Date = new Date()): Promise<Job> {
      // The INSERT computes it, so no job is ever born unscheduled by accident
      // and there is no orphan-adoption path for the tick to implement. An
      // unparseable expression throws here, before anything is written — the
      // parse is the validation, because a CHECK could not be.
      const nextRunAt = computeNextRunAt(
        job.scheduleCron,
        job.scheduleTimezone ?? "UTC",
        now
      )

      const { rows } = await connection.query<JobRow>(
        `insert into jobs (user_id, name, config, schedule_cron, schedule_timezone, next_run_at)
         values ($1, $2, $3, $4, $5, $6)
         returning ${COLUMNS}`,
        [
          job.userId,
          job.name,
          JSON.stringify(job.config ?? {}),
          job.scheduleCron,
          job.scheduleTimezone ?? "UTC",
          nextRunAt,
        ]
      )

      return toJob(expectOne(rows, "insert into jobs returned no row"))
    },

    async get(id: string): Promise<Job | undefined> {
      const { rows } = await connection.query<JobRow>(
        `select ${COLUMNS} from jobs where id = $1`,
        [id]
      )

      return rows[0] ? toJob(rows[0]) : undefined
    },

    async listForUser(userId: string): Promise<Job[]> {
      const { rows } = await connection.query<JobRow>(
        `select ${COLUMNS} from jobs where user_id = $1 order by created_at desc`,
        [userId]
      )

      return rows.map(toJob)
    },

    async dueJobs(
      now: Date = new Date(),
      limit: number = DEFAULT_DUE_LIMIT
    ): Promise<DueJob[]> {
      // `next_run_at is not null` is redundant against `<= $1` — NULL compares
      // to nothing — and is stated anyway, because it is the predicate of
      // `jobs_next_run_at_idx`. Without it the planner has no partial index to
      // match.
      const { rows } = await connection.query<JobRow>(
        `select ${COLUMNS} from jobs
         where next_run_at is not null and next_run_at <= $1
         order by next_run_at asc
         limit $2`,
        [now, limit]
      )

      return rows.map(toDueJob)
    },

    async claim(
      job: DueJob,
      now: Date = new Date()
    ): Promise<ClaimedSlot | undefined> {
      // Computed from `now`, not from the slot being claimed, and that is what
      // makes a missed schedule run once and jump forward rather than owe a
      // backfill. A job that was down for a week is due once.
      const fromNow = computeNextRunAt(
        job.scheduleCron,
        job.scheduleTimezone,
        now
      )

      // ...but a claim must always move the slot forward, and computing from
      // `now` only guarantees that while `now >= job.nextRunAt`. Claim a job
      // whose slot has not arrived yet and the next occurrence after `now` is
      // that same slot, so the guarded UPDATE below would write the value it
      // matched on: the row is claimed, the slot never advances, and every
      // later tick is turned away by the unique index instead. The job would
      // sit there looking due and never run again.
      //
      // `dueJobs()` never returns such a job, so the tick cannot reach this —
      // which is exactly why it is worth making structural rather than relying
      // on every caller to check first.
      const nextRunAt =
        fromNow > job.nextRunAt
          ? fromNow
          : computeNextRunAt(
              job.scheduleCron,
              job.scheduleTimezone,
              job.nextRunAt
            )

      return connection.transaction(async (tx) => {
        // Guarded on the observed value. Two ticks reading the same due row
        // both compute the same advance, and only one of them updates a row
        // still holding the old one.
        const advanced = await tx.query(
          `update jobs set next_run_at = $2, updated_at = now()
           where id = $1 and next_run_at = $3`,
          [job.id, nextRunAt, job.nextRunAt]
        )

        if (advanced.rowCount === 0) return undefined

        // The structural backstop, which matters because the guard above could
        // be refactored wrong. `WHERE scheduled_for IS NOT NULL` is not
        // optional: `ON CONFLICT` infers a partial index from it, and without
        // it the statement errors rather than misbehaving.
        const inserted = await tx.query<{ id: string }>(
          `insert into runs (job_id, scheduled_for, status)
           values ($1, $2, 'running')
           on conflict (job_id, scheduled_for) where scheduled_for is not null
           do nothing
           returning id`,
          [job.id, job.nextRunAt]
        )

        const run = inserted.rows[0]

        // Zero rows means another party already holds this slot. Nothing was
        // overwritten — which is why there is no rule here about not clobbering
        // `started_at` or resurrecting a terminal status. There is nothing to
        // get right.
        if (!run) return undefined

        return { runId: run.id, scheduledFor: job.nextRunAt, nextRunAt }
      })
    },

    async updateSchedule(
      id: string,
      schedule: { cron: string; timezone?: string },
      now: Date = new Date()
    ): Promise<Job | undefined> {
      const timezone = schedule.timezone ?? "UTC"
      const nextRunAt = computeNextRunAt(schedule.cron, timezone, now)

      const { rows } = await connection.query<JobRow>(
        `update jobs
         set schedule_cron     = $2,
             schedule_timezone = $3,
             -- A paused job stays paused. NULL means "not scheduled", so
             -- writing the new occurrence unconditionally would put a retired
             -- job back on duty as a side effect of tidying up its cron.
             --
             -- The cast is required, not decoration. Everywhere else a
             -- parameter is assigned straight to a column and Postgres infers
             -- its type from that column, but inside a CASE the other branch is
             -- an untyped NULL, so there is nothing to infer from and the
             -- parameter defaults to text — which fails with "column
             -- next_run_at is of type timestamp with time zone but expression
             -- is of type text". This statement is unreachable from the tick,
             -- so only an integration test catches it.
             next_run_at       = case when next_run_at is null then null else $4::timestamptz end,
             updated_at        = now()
         where id = $1
         returning ${COLUMNS}`,
        [id, schedule.cron, timezone, nextRunAt]
      )

      return rows[0] ? toJob(rows[0]) : undefined
    },

    async pause(id: string): Promise<Job | undefined> {
      const { rows } = await connection.query<JobRow>(
        `update jobs set next_run_at = null, updated_at = now()
         where id = $1
         returning ${COLUMNS}`,
        [id]
      )

      return rows[0] ? toJob(rows[0]) : undefined
    },

    async resume(id: string, now: Date = new Date()): Promise<Job | undefined> {
      // Read first, because the next occurrence depends on the job's own cron
      // and timezone, and computing it in SQL would mean parsing cron in
      // Postgres.
      const job = await store.get(id)
      if (!job) return undefined

      const nextRunAt = computeNextRunAt(
        job.scheduleCron,
        job.scheduleTimezone,
        now
      )

      const { rows } = await connection.query<JobRow>(
        `update jobs set next_run_at = $2, updated_at = now()
         where id = $1
         returning ${COLUMNS}`,
        [id, nextRunAt]
      )

      return rows[0] ? toJob(rows[0]) : undefined
    },
  }

  return store
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    config: row.config,
    scheduleCron: row.schedule_cron,
    scheduleTimezone: row.schedule_timezone,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Only ever called on rows the `next_run_at is not null` filter produced. */
function toDueJob(row: JobRow): DueJob {
  const job = toJob(row)

  if (!job.nextRunAt) {
    throw new Error(
      `Job ${job.id} came back from a due query with no next_run_at, which the query's own WHERE clause forbids.`
    )
  }

  return { ...job, nextRunAt: job.nextRunAt }
}

function expectOne<T>(rows: T[], message: string): T {
  const row = rows[0]
  if (!row) throw new Error(message)
  return row
}
