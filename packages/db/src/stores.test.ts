import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  artifactsForRun,
  claimJob,
  createJob,
  createPrismaClient,
  dueJobs,
  ensureUserForAuth,
  failRun,
  finishRun,
  latestArtifactForJob,
  pauseJob,
  recordArtifact,
  resumeJob,
  startAdHocRun,
  updateJobSchedule,
  type DueJob,
  type PrismaClient,
} from "./index.ts"

/**
 * The half of this package that needs Postgres to be Postgres.
 *
 * Everything asserted below is a property of the database rather than of the
 * code — a partial unique index, a CHECK, an `ON CONFLICT` predicate, a
 * conditional `UPDATE` under concurrency. A fake cannot enforce any of them.
 *
 * Skipped when `DATABASE_URL_UNPOOLED` is unset, so `pnpm test` stays runnable
 * with no credentials. In CI a disposable Neon branch supplies it.
 *
 * The direct endpoint, not the pooled one. Deploy uses `prisma migrate deploy`;
 * this suite applies the same SQL into a throwaway schema via `search_path` so
 * it cannot touch data it did not write. Prisma Migrate's emptiness check looks
 * at the whole database, so `migrate deploy` cannot target an isolated schema
 * beside an existing `public`.
 */
const CONNECTION_STRING = process.env.DATABASE_URL_UNPOOLED?.trim()

const SCHEMA = `db_test_${randomUUID().replaceAll("-", "")}`

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

/**
 * Postgres resolves unqualified names through `search_path`, so pointing it at
 * the throwaway schema is what makes the migration SQL — which names no schema
 * — land there.
 */
const describeWithDatabase = CONNECTION_STRING ? describe : describe.skip

describeWithDatabase("against a real database", () => {
  let baseUrl: string
  let admin: pg.Client
  let prisma: PrismaClient
  let userId: string

  beforeAll(async () => {
    baseUrl = CONNECTION_STRING as string

    admin = new pg.Client({ connectionString: baseUrl })
    await admin.connect()
    await admin.query(`create schema "${SCHEMA}"`)

    const sql = await readFile(
      join(packageRoot, "prisma/migrations/0001_init/migration.sql"),
      "utf8"
    )

    // Pin search_path so unqualified DDL lands in the throwaway schema.
    const migrator = new pg.Client({ connectionString: baseUrl })
    await migrator.connect()
    try {
      await migrator.query(`SET search_path TO "${SCHEMA}"`)
      await migrator.query(sql)
    } finally {
      await migrator.end()
    }

    prisma = createPrismaClient({ connectionString: baseUrl, schema: SCHEMA })
    const user = await prisma.user.create({ data: {} })
    userId = user.id
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await admin?.query(`drop schema if exists "${SCHEMA}" cascade`)
    await admin?.end()
  })

  const OVERDUE_BY_DAYS = 7

  async function dueJob(name: string): Promise<DueJob> {
    const created = await createJob(prisma, {
      userId,
      name,
      scheduleCron: "0 9 * * *",
      scheduleTimezone: "UTC",
      config: { topic: "example" },
    })

    const overdue = new Date(Date.now() - OVERDUE_BY_DAYS * 86_400_000)

    await admin.query(
      `update "${SCHEMA}".jobs set next_run_at = $2 where id = $1`,
      [created.id, overdue]
    )

    const due = await prisma.job.findUnique({ where: { id: created.id } })
    if (!due?.nextRunAt) throw new Error("fixture job is not due")
    if (due.nextRunAt.getTime() >= Date.now()) {
      throw new Error("fixture job's slot is not in the past")
    }

    return { ...due, nextRunAt: due.nextRunAt }
  }

  async function claimOrFail(job: DueJob) {
    const slot = await claimJob(prisma, job)
    if (!slot) throw new Error(`claim of ${job.name} returned no slot`)
    return slot
  }

  describe("the claim", () => {
    it("hands one slot to exactly one of two concurrent claimants", async () => {
      const job = await dueJob("concurrent-claim")

      const rival = createPrismaClient({
        connectionString: baseUrl,
        schema: SCHEMA,
      })

      try {
        const [mine, theirs] = await Promise.all([
          claimJob(prisma, job),
          claimJob(rival, job),
        ])

        const winners = [mine, theirs].filter((slot) => slot !== undefined)
        expect(winners).toHaveLength(1)
        expect(winners[0]?.scheduledFor.toISOString()).toBe(
          job.nextRunAt.toISOString()
        )

        const runs = await prisma.run.findMany({
          where: { jobId: job.id },
          orderBy: { startedAt: "desc" },
        })
        expect(runs).toHaveLength(1)
        expect(runs[0]?.status).toBe("running")
      } finally {
        await rival.$disconnect()
      }
    })

    it("advances next_run_at past the claimed slot", async () => {
      const job = await dueJob("advances-slot")

      const slot = await claimJob(prisma, job)
      expect(slot).toBeDefined()

      const after = await prisma.job.findUnique({ where: { id: job.id } })
      expect(after?.nextRunAt?.getTime()).toBe(slot?.nextRunAt.getTime())
      expect(after?.nextRunAt?.getTime()).toBeGreaterThan(
        job.nextRunAt.getTime()
      )
    })

    it("advances the slot even when claimed before it is due", async () => {
      const job = await createJob(prisma, {
        userId,
        name: "not-yet-due",
        scheduleCron: "0 9 * * *",
        scheduleTimezone: "UTC",
      })

      if (!job.nextRunAt) throw new Error("a new job must have a slot")
      expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now())

      const slot = await claimOrFail({ ...job, nextRunAt: job.nextRunAt })

      expect(slot.nextRunAt.getTime()).toBeGreaterThan(job.nextRunAt.getTime())

      const after = await prisma.job.findUnique({ where: { id: job.id } })
      expect(after?.nextRunAt?.getTime()).toBe(slot.nextRunAt.getTime())
    })

    it("refuses a second claim of the same observed slot", async () => {
      const job = await dueJob("second-claim")

      expect(await claimJob(prisma, job)).toBeDefined()
      expect(await claimJob(prisma, job)).toBeUndefined()
    })

    it("does not select an unscheduled job", async () => {
      const job = await dueJob("paused-job")
      await pauseJob(prisma, job.id)

      const due = await dueJobs(prisma, new Date("2027-01-01T00:00:00.000Z"))
      expect(due.map((row) => row.id)).not.toContain(job.id)
    })
  })

  describe("ad-hoc runs", () => {
    it("allows any number of them alongside unique scheduled ones", async () => {
      const job = await dueJob("ad-hoc")
      await claimJob(prisma, job)

      const first = await startAdHocRun(prisma, job.id)
      const second = await startAdHocRun(prisma, job.id)
      const third = await startAdHocRun(prisma, job.id)

      expect(new Set([first.id, second.id, third.id]).size).toBe(3)
      for (const run of [first, second, third]) {
        expect(run.scheduledFor).toBeNull()
      }

      expect(await claimJob(prisma, job)).toBeUndefined()
    })
  })

  describe("status transitions", () => {
    it("cannot walk a terminal run back to running", async () => {
      const job = await dueJob("terminal-run")
      const { runId } = await claimOrFail(job)

      expect(await finishRun(prisma, runId)).toBe(true)
      expect(await failRun(prisma, runId, { reason: "too late" })).toBe(false)
      expect(await finishRun(prisma, runId)).toBe(false)

      const run = await prisma.run.findUnique({ where: { id: runId } })
      expect(run?.status).toBe("succeeded")
      expect(run?.failure).toBeNull()
      expect(run?.finishedAt).not.toBeNull()
    })

    it("records partial success as succeeded with a failure payload", async () => {
      const job = await dueJob("partial-success")
      const { runId } = await claimOrFail(job)

      await finishRun(prisma, runId, { sources: { example: "timed out" } })

      const run = await prisma.run.findUnique({ where: { id: runId } })
      expect(run?.status).toBe("succeeded")
      expect(run?.failure).toEqual({ sources: { example: "timed out" } })
    })
  })

  describe("artifacts", () => {
    it("accepts an object key in the shape user-storage builds", async () => {
      const job = await dueJob("artifact-key")
      const { runId } = await claimOrFail(job)

      const key = `prod/${userId}/briefs/2026/07/28/morning.md`
      const artifact = await recordArtifact(prisma, runId, key)

      expect(artifact.objectKey).toBe(key)
      expect(await artifactsForRun(prisma, runId)).toHaveLength(1)
    })

    it("rejects a URL", async () => {
      const job = await dueJob("artifact-url")
      const { runId } = await claimOrFail(job)

      await expect(
        recordArtifact(
          prisma,
          runId,
          `https://bucket.s3.amazonaws.com/prod/${userId}/briefs/2026/07/28/morning.md`
        )
      ).rejects.toThrow()
    })

    it("rejects a leading slash", async () => {
      const job = await dueJob("artifact-slash")
      const { runId } = await claimOrFail(job)

      await expect(
        recordArtifact(prisma, runId, `/prod/${userId}/briefs/2026/07/28/x.md`)
      ).rejects.toThrow()
    })

    it("refuses to record the same object twice", async () => {
      const job = await dueJob("artifact-duplicate")
      const { runId } = await claimOrFail(job)

      const key = `prod/${userId}/briefs/2026/07/29/morning.md`
      await recordArtifact(prisma, runId, key)

      await expect(recordArtifact(prisma, runId, key)).rejects.toThrow()
    })

    it("finds the latest artifact of a successful run", async () => {
      const job = await dueJob("artifact-latest")

      const older = await claimOrFail(job)
      await recordArtifact(
        prisma,
        older.runId,
        `prod/${userId}/briefs/2026/07/30/a.md`
      )
      await finishRun(prisma, older.runId)

      const refreshed = await prisma.job.findUnique({ where: { id: job.id } })
      if (!refreshed?.nextRunAt) throw new Error("job lost its slot")

      const newer = await claimOrFail({
        ...refreshed,
        nextRunAt: refreshed.nextRunAt,
      })
      const latestKey = `prod/${userId}/briefs/2026/07/31/b.md`
      await recordArtifact(prisma, newer.runId, latestKey)
      await finishRun(prisma, newer.runId)

      expect((await latestArtifactForJob(prisma, job.id))?.objectKey).toBe(
        latestKey
      )
    })
  })

  describe("schedule edits", () => {
    it("recomputes next_run_at when the cron changes", async () => {
      const job = await dueJob("schedule-edit")

      const edited = await updateJobSchedule(prisma, job.id, {
        cron: "0 17 * * *",
        timezone: "UTC",
      })

      expect(edited?.scheduleCron).toBe("0 17 * * *")
      expect(edited?.nextRunAt?.getTime()).not.toBe(job.nextRunAt.getTime())
      expect(edited?.nextRunAt?.getUTCHours()).toBe(17)
    })

    it("leaves a paused job paused", async () => {
      const job = await dueJob("paused-edit")
      await pauseJob(prisma, job.id)

      const edited = await updateJobSchedule(prisma, job.id, {
        cron: "0 17 * * *",
      })

      expect(edited?.scheduleCron).toBe("0 17 * * *")
      expect(edited?.nextRunAt).toBeNull()
    })

    it("refuses a schedule that cannot fire, before writing anything", async () => {
      const job = await dueJob("bad-schedule")

      await expect(
        updateJobSchedule(prisma, job.id, { cron: "not a cron" })
      ).rejects.toThrow()

      const unchanged = await prisma.job.findUnique({ where: { id: job.id } })
      expect(unchanged?.scheduleCron).toBe("0 9 * * *")
    })

    it("puts a paused job back on duty at the next occurrence", async () => {
      const job = await dueJob("resume-job")
      await pauseJob(prisma, job.id)

      const resumed = await resumeJob(prisma, job.id)
      expect(resumed?.nextRunAt).not.toBeNull()
      expect(resumed?.nextRunAt?.getTime()).toBeGreaterThan(Date.now() - 1000)
    })
  })

  describe("the auth identity link", () => {
    it("mints one user for an identity it has never seen", async () => {
      const authUserId = `auth_${randomUUID()}`

      const user = await ensureUserForAuth(prisma, authUserId)

      expect(user.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
      expect(user.id).not.toBe(authUserId)
      expect(
        await prisma.user.findUnique({ where: { id: user.id } })
      ).toBeDefined()
    })

    it("returns the same user on every later request", async () => {
      const authUserId = `auth_${randomUUID()}`

      const first = await ensureUserForAuth(prisma, authUserId)
      const second = await ensureUserForAuth(prisma, authUserId)

      expect(second.id).toBe(first.id)
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime())
    })

    it("mints once for two concurrent first requests", async () => {
      const authUserId = `auth_${randomUUID()}`

      const rival = createPrismaClient({
        connectionString: baseUrl,
        schema: SCHEMA,
      })

      try {
        const [mine, theirs] = await Promise.all([
          ensureUserForAuth(prisma, authUserId),
          ensureUserForAuth(rival, authUserId),
        ])

        expect(theirs.id).toBe(mine.id)

        const { rows } = await admin.query<{ count: string }>(
          `select count(*)::text as count from "${SCHEMA}".users where auth_user_id = $1`,
          [authUserId]
        )
        expect(rows[0]?.count).toBe("1")
      } finally {
        await rival.$disconnect()
      }
    })

    it("keeps unlinked users legal, and there can be many", async () => {
      await prisma.user.create({ data: {} })
      await prisma.user.create({ data: {} })

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".users where auth_user_id is null`
      )
      expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(3)
    })

    it("refuses to point two users at one identity", async () => {
      const authUserId = `auth_${randomUUID()}`
      await ensureUserForAuth(prisma, authUserId)

      const other = await prisma.user.create({ data: {} })

      await expect(
        admin.query(
          `update "${SCHEMA}".users set auth_user_id = $1 where id = $2`,
          [authUserId, other.id]
        )
      ).rejects.toThrow()
    })
  })

  describe("referential integrity", () => {
    it("refuses to delete a user who still owns jobs", async () => {
      const job = await dueJob("restrict-delete")

      await expect(
        admin.query(`delete from "${SCHEMA}".users where id = $1`, [userId])
      ).rejects.toThrow()

      expect(
        await prisma.job.findUnique({ where: { id: job.id } })
      ).toBeDefined()
    })

    it("refuses two jobs with the same name for one user", async () => {
      await createJob(prisma, {
        userId,
        name: "duplicate-name",
        scheduleCron: "0 9 * * *",
      })

      await expect(
        createJob(prisma, {
          userId,
          name: "duplicate-name",
          scheduleCron: "0 9 * * *",
        })
      ).rejects.toThrow()
    })
  })
})
