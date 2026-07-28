import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createConnection, type Connection } from "./client.ts"
import type { DatabaseConfig } from "./config.ts"
import { createDb, type Db } from "./db.ts"
import { runMigrations } from "./migrate.ts"
import type { DueJob } from "./rows.ts"

/**
 * The half of this package that needs Postgres to be Postgres.
 *
 * Everything asserted below is a property of the database rather than of the
 * code — a partial unique index, a CHECK, an `ON CONFLICT` predicate, a
 * conditional `UPDATE` under concurrency. A fake cannot enforce any of them, so
 * mocking `pg` here would assert only that the code sends the SQL it sends.
 *
 * Skipped when `DATABASE_URL_UNPOOLED` is unset, so `pnpm test` stays runnable
 * with no credentials. In CI a disposable Neon branch supplies it.
 *
 * The direct endpoint, not the pooled one: the migration runner takes a
 * session-level advisory lock, which PgBouncer in transaction mode does not
 * carry across statements.
 */
const CONNECTION_STRING = process.env.DATABASE_URL_UNPOOLED?.trim()

/**
 * Every test runs inside a schema of its own, created here and dropped at the
 * end.
 *
 * Not truncation, and deliberately: whoever runs this locally may well have
 * `DATABASE_URL_UNPOOLED` pointing at a database with data in it, and a test
 * suite that empties tables is one misconfigured variable away from being
 * destructive. A private schema cannot reach anything it did not create.
 */
const SCHEMA = `db_test_${randomUUID().replaceAll("-", "")}`

/**
 * Postgres resolves unqualified names through `search_path`, so pointing it at
 * the throwaway schema is what makes the migration files — which name no schema
 * — land there.
 *
 * Built by hand rather than with `URLSearchParams`, which encodes a space as
 * `+`; the connection-string parser decodes with `decodeURIComponent` and would
 * hand the server a literal plus.
 */
function withSearchPath(connectionString: string, schema: string): string {
  const separator = connectionString.includes("?") ? "&" : "?"
  return `${connectionString}${separator}options=-c%20search_path%3D${schema}`
}

const describeWithDatabase = CONNECTION_STRING ? describe : describe.skip

describeWithDatabase("against a real database", () => {
  // Built in `beforeAll`, not here: `describe.skip` still runs this callback to
  // register the skipped tests, so anything touching the (absent) connection
  // string at collection time would throw instead of skipping.
  let config: DatabaseConfig
  let admin: Connection
  let db: Db
  let userId: string

  beforeAll(async () => {
    const base = CONNECTION_STRING as string
    config = { connectionString: withSearchPath(base, SCHEMA) }

    admin = createConnection({ connectionString: base })
    await admin.query(`create schema "${SCHEMA}"`)

    // Acceptance: applies cleanly from an empty database.
    const first = await runMigrations({ config })
    expect(first.applied).toContain("0001_init.sql")
    expect(first.skipped).toEqual([])

    // Acceptance: running twice is a no-op.
    const second = await runMigrations({ config })
    expect(second.applied).toEqual([])
    expect(second.skipped).toContain("0001_init.sql")

    db = createDb(config)
    userId = (await db.users.create()).id
  })

  afterAll(async () => {
    await db?.close()
    await admin?.query(`drop schema if exists "${SCHEMA}" cascade`)
    await admin?.close()
  })

  /**
   * The slot every fixture job is overdue for.
   *
   * Relative to the wall clock rather than a literal date, and that matters: a
   * hard-coded instant is only in the past until the suite is run on a day that
   * has caught up with it, and a slot that is not actually overdue makes the
   * claim's advance a silent no-op — which is a test that passes for the wrong
   * reason on one day and fails confusingly on another.
   */
  const OVERDUE_BY_DAYS = 7

  /** A job that is genuinely overdue, which is the state `claim()` expects. */
  async function dueJob(name: string): Promise<DueJob> {
    const job = await db.jobs.create({
      userId,
      name,
      scheduleCron: "0 9 * * *",
      scheduleTimezone: "UTC",
      config: { topic: "example" },
    })

    const overdue = new Date(Date.now() - OVERDUE_BY_DAYS * 86_400_000)

    // Reach past the store on purpose: nothing in the public surface can put a
    // job's slot in the past, because nothing legitimately should.
    await admin.query(
      `update "${SCHEMA}".jobs set next_run_at = $2 where id = $1`,
      [job.id, overdue]
    )

    const due = await db.jobs.get(job.id)
    if (!due?.nextRunAt) throw new Error("fixture job is not due")
    if (due.nextRunAt.getTime() >= Date.now()) {
      throw new Error("fixture job's slot is not in the past")
    }

    return { ...due, nextRunAt: due.nextRunAt }
  }

  /** Claim, and fail the test rather than the next statement if it did not. */
  async function claimOrFail(job: DueJob) {
    const slot = await db.jobs.claim(job)
    if (!slot) throw new Error(`claim of ${job.name} returned no slot`)
    return slot
  }

  describe("the claim", () => {
    it("hands one slot to exactly one of two concurrent claimants", async () => {
      const job = await dueJob("concurrent-claim")

      // Two connections, because two ticks are two processes. One connection
      // would serialise the transactions and prove nothing about the race.
      const rival = createDb(config)

      try {
        const [mine, theirs] = await Promise.all([
          db.jobs.claim(job),
          rival.jobs.claim(job),
        ])

        const winners = [mine, theirs].filter((slot) => slot !== undefined)
        expect(winners).toHaveLength(1)
        expect(winners[0]?.scheduledFor.toISOString()).toBe(
          job.nextRunAt.toISOString()
        )

        // And exactly one run row exists for that occurrence.
        const runs = await db.runs.recent(job.id)
        expect(runs).toHaveLength(1)
        expect(runs[0]?.status).toBe("running")
      } finally {
        await rival.close()
      }
    })

    it("advances next_run_at past the claimed slot", async () => {
      const job = await dueJob("advances-slot")

      const slot = await db.jobs.claim(job)
      expect(slot).toBeDefined()

      const after = await db.jobs.get(job.id)
      expect(after?.nextRunAt?.getTime()).toBe(slot?.nextRunAt.getTime())
      expect(after?.nextRunAt?.getTime()).toBeGreaterThan(
        job.nextRunAt.getTime()
      )
    })

    it("advances the slot even when claimed before it is due", async () => {
      // `create()` sets `next_run_at` to the next *future* occurrence, so this
      // job is deliberately not due. `dueJobs()` would never return it, but a
      // caller can still hand it to `claim()` — and if the advance were
      // computed only from `now`, the next occurrence after `now` would be this
      // very slot. The guarded UPDATE would then write the value it matched on,
      // leaving the job claimed, its slot unmoved, and every later tick turned
      // away by the unique index. Wedged, and looking due the whole time.
      const job = await db.jobs.create({
        userId,
        name: "not-yet-due",
        scheduleCron: "0 9 * * *",
        scheduleTimezone: "UTC",
      })

      if (!job.nextRunAt) throw new Error("a new job must have a slot")
      expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now())

      const slot = await claimOrFail({ ...job, nextRunAt: job.nextRunAt })

      expect(slot.nextRunAt.getTime()).toBeGreaterThan(job.nextRunAt.getTime())

      const after = await db.jobs.get(job.id)
      expect(after?.nextRunAt?.getTime()).toBe(slot.nextRunAt.getTime())
    })

    it("refuses a second claim of the same observed slot", async () => {
      const job = await dueJob("second-claim")

      expect(await db.jobs.claim(job)).toBeDefined()
      // Same stale `job` object, so the guarded UPDATE sees a moved row.
      expect(await db.jobs.claim(job)).toBeUndefined()
    })

    it("does not select an unscheduled job", async () => {
      const job = await dueJob("paused-job")
      await db.jobs.pause(job.id)

      const due = await db.jobs.dueJobs(new Date("2027-01-01T00:00:00.000Z"))
      expect(due.map((row) => row.id)).not.toContain(job.id)
    })
  })

  describe("ad-hoc runs", () => {
    it("allows any number of them alongside unique scheduled ones", async () => {
      const job = await dueJob("ad-hoc")
      await db.jobs.claim(job)

      // Postgres treats NULLs as distinct inside a unique index, which is what
      // the partial index depends on. Three manual runs, no collision.
      const first = await db.runs.startAdHoc(job.id)
      const second = await db.runs.startAdHoc(job.id)
      const third = await db.runs.startAdHoc(job.id)

      expect(new Set([first.id, second.id, third.id]).size).toBe(3)
      for (const run of [first, second, third]) {
        expect(run.scheduledFor).toBeNull()
      }

      // The scheduled slot is still unique.
      expect(await db.jobs.claim(job)).toBeUndefined()
    })
  })

  describe("status transitions", () => {
    it("cannot walk a terminal run back to running", async () => {
      const job = await dueJob("terminal-run")
      const { runId } = await claimOrFail(job)

      expect(await db.runs.finish(runId)).toBe(true)

      // Both return false rather than throwing: a lost race, not an error to
      // retry. The conditional UPDATE matched no row.
      expect(await db.runs.fail(runId, { reason: "too late" })).toBe(false)
      expect(await db.runs.finish(runId)).toBe(false)

      const run = await db.runs.get(runId)
      expect(run?.status).toBe("succeeded")
      expect(run?.failure).toBeNull()
      expect(run?.finishedAt).not.toBeNull()
    })

    it("records partial success as succeeded with a failure payload", async () => {
      const job = await dueJob("partial-success")
      const { runId } = await claimOrFail(job)

      await db.runs.finish(runId, { sources: { example: "timed out" } })

      const run = await db.runs.get(runId)
      expect(run?.status).toBe("succeeded")
      expect(run?.failure).toEqual({ sources: { example: "timed out" } })
    })
  })

  describe("artifacts", () => {
    it("accepts an object key in the shape user-storage builds", async () => {
      const job = await dueJob("artifact-key")
      const { runId } = await claimOrFail(job)

      const key = `prod/${userId}/briefs/2026/07/28/morning.md`
      const artifact = await db.artifacts.record(runId, key)

      expect(artifact.objectKey).toBe(key)
      expect(await db.artifacts.forRun(runId)).toHaveLength(1)
    })

    it("rejects a URL", async () => {
      const job = await dueJob("artifact-url")
      const { runId } = await claimOrFail(job)

      await expect(
        db.artifacts.record(
          runId,
          `https://bucket.s3.amazonaws.com/prod/${userId}/briefs/2026/07/28/morning.md`
        )
      ).rejects.toThrow()
    })

    it("rejects a leading slash", async () => {
      const job = await dueJob("artifact-slash")
      const { runId } = await claimOrFail(job)

      await expect(
        db.artifacts.record(runId, `/prod/${userId}/briefs/2026/07/28/x.md`)
      ).rejects.toThrow()
    })

    it("refuses to record the same object twice", async () => {
      const job = await dueJob("artifact-duplicate")
      const { runId } = await claimOrFail(job)

      const key = `prod/${userId}/briefs/2026/07/29/morning.md`
      await db.artifacts.record(runId, key)

      await expect(db.artifacts.record(runId, key)).rejects.toThrow()
    })

    it("finds the latest artifact of a successful run", async () => {
      const job = await dueJob("artifact-latest")

      const older = await claimOrFail(job)
      await db.artifacts.record(
        older.runId,
        `prod/${userId}/briefs/2026/07/30/a.md`
      )
      await db.runs.finish(older.runId)

      // Re-read rather than reusing `job`: the first claim advanced the slot,
      // so the stale object would be turned away by the guarded UPDATE. That
      // the re-read job is still claimable is itself the assertion that the
      // claim moved `next_run_at` forward.
      const refreshed = await db.jobs.get(job.id)
      if (!refreshed?.nextRunAt) throw new Error("job lost its slot")

      const newer = await claimOrFail({
        ...refreshed,
        nextRunAt: refreshed.nextRunAt,
      })
      const latestKey = `prod/${userId}/briefs/2026/07/31/b.md`
      await db.artifacts.record(newer.runId, latestKey)
      await db.runs.finish(newer.runId)

      expect((await db.artifacts.latestForJob(job.id))?.objectKey).toBe(
        latestKey
      )
    })
  })

  describe("schedule edits", () => {
    it("recomputes next_run_at when the cron changes", async () => {
      const job = await dueJob("schedule-edit")

      const edited = await db.jobs.updateSchedule(job.id, {
        cron: "0 17 * * *",
        timezone: "UTC",
      })

      expect(edited?.scheduleCron).toBe("0 17 * * *")
      // The old slot is gone, which is the failure this exists to prevent: a
      // job that keeps firing on the cron it no longer has.
      expect(edited?.nextRunAt?.getTime()).not.toBe(job.nextRunAt.getTime())
      expect(edited?.nextRunAt?.getUTCHours()).toBe(17)
    })

    it("leaves a paused job paused", async () => {
      const job = await dueJob("paused-edit")
      await db.jobs.pause(job.id)

      const edited = await db.jobs.updateSchedule(job.id, {
        cron: "0 17 * * *",
      })

      expect(edited?.scheduleCron).toBe("0 17 * * *")
      expect(edited?.nextRunAt).toBeNull()
    })

    it("refuses a schedule that cannot fire, before writing anything", async () => {
      const job = await dueJob("bad-schedule")

      await expect(
        db.jobs.updateSchedule(job.id, { cron: "not a cron" })
      ).rejects.toThrow()

      const unchanged = await db.jobs.get(job.id)
      expect(unchanged?.scheduleCron).toBe("0 9 * * *")
    })
  })

  describe("referential integrity", () => {
    it("refuses to delete a user who still owns jobs", async () => {
      const job = await dueJob("restrict-delete")

      await expect(
        admin.query(`delete from "${SCHEMA}".users where id = $1`, [userId])
      ).rejects.toThrow()

      expect(await db.jobs.get(job.id)).toBeDefined()
    })

    it("refuses two jobs with the same name for one user", async () => {
      await db.jobs.create({
        userId,
        name: "duplicate-name",
        scheduleCron: "0 9 * * *",
      })

      await expect(
        db.jobs.create({
          userId,
          name: "duplicate-name",
          scheduleCron: "0 9 * * *",
        })
      ).rejects.toThrow()
    })
  })
})
