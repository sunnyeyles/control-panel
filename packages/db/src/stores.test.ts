import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  claimAdHocRun,
  claimJob,
  coverLetterInstructions,
  createJob,
  createPrismaClient,
  deletePostings,
  dueJobs,
  ensureUserForAuth,
  failRun,
  finishRun,
  latestRunPerJob,
  pauseJob,
  POSTING_STATUSES,
  ownedPostingIds,
  recordArtifact,
  recordPostings,
  recordRunFindings,
  resumeJob,
  runningRunForJob,
  saveCoverLetterInstructions,
  setPostingStatus,
  startAdHocRun,
  updateJobSchedule,
  type DueJob,
  type NewPosting,
  type PostingStatus,
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

    // Every migration, in the order `migrate deploy` would apply them — the
    // directory names sort into that order and are the only thing that
    // decides it. Reading the directory rather than naming a file is what
    // keeps this suite from testing a schema two migrations old.
    const migrations = join(packageRoot, "prisma/migrations")
    const directories = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    // Pin search_path so unqualified DDL lands in the throwaway schema.
    const migrator = new pg.Client({ connectionString: baseUrl })
    await migrator.connect()
    try {
      await migrator.query(`SET search_path TO "${SCHEMA}"`)

      for (const directory of directories) {
        await migrator.query(
          await readFile(join(migrations, directory, "migration.sql"), "utf8")
        )
      }
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

    it("claims one exactly once, whatever the delivery count", async () => {
      const job = await dueJob("ad-hoc-claim")
      const run = await startAdHocRun(prisma, job.id)

      const first = await claimAdHocRun(prisma, run.id)
      const second = await claimAdHocRun(prisma, run.id)

      expect(first).toMatchObject({ jobId: job.id })
      expect(first?.startedAt.getTime()).toBe(run.startedAt.getTime())
      expect(second).toBeUndefined()

      const claimed = await prisma.run.findUnique({ where: { id: run.id } })
      expect(claimed?.claimedAt).not.toBeNull()
    })

    it("refuses to claim a run that is already terminal", async () => {
      const job = await dueJob("ad-hoc-terminal")
      const run = await startAdHocRun(prisma, job.id)

      expect(await finishRun(prisma, run.id)).toBe(true)
      expect(await claimAdHocRun(prisma, run.id)).toBeUndefined()
    })

    it("refuses to claim a scheduled run, which the slot already protects", async () => {
      const job = await dueJob("ad-hoc-not-scheduled")
      const { runId } = await claimOrFail(job)

      expect(await claimAdHocRun(prisma, runId)).toBeUndefined()
    })

    it("does not advance the schedule", async () => {
      const job = await dueJob("ad-hoc-no-slot")
      const before = await prisma.job.findUnique({ where: { id: job.id } })

      const run = await startAdHocRun(prisma, job.id)
      await claimAdHocRun(prisma, run.id)

      const after = await prisma.job.findUnique({ where: { id: job.id } })
      expect(after?.nextRunAt?.getTime()).toBe(before?.nextRunAt?.getTime())
    })
  })

  describe("reading runs back", () => {
    it("returns the newest run of each job and nobody else's", async () => {
      const mine = await dueJob("latest-mine")
      const older = await startAdHocRun(prisma, mine.id)
      await finishRun(prisma, older.id)
      const newest = await startAdHocRun(prisma, mine.id)

      const summaries = await latestRunPerJob(prisma, userId)
      const forJob = summaries.filter((row) => row.jobId === mine.id)

      expect(forJob).toHaveLength(1)
      expect(forJob[0]?.id).toBe(newest.id)
      expect(forJob[0]?.status).toBe("running")
      expect(forJob[0]?.scheduledFor).toBeNull()

      const stranger = await ensureUserForAuth(prisma, randomUUID())
      expect(await latestRunPerJob(prisma, stranger.id)).toEqual([])
    })

    it("finds a run still going, and ignores one that started too long ago", async () => {
      const job = await dueJob("in-flight")
      const run = await startAdHocRun(prisma, job.id)

      const wellBefore = new Date(run.startedAt.getTime() - 60_000)
      const wellAfter = new Date(run.startedAt.getTime() + 60_000)

      expect(await runningRunForJob(prisma, job.id, wellBefore)).toMatchObject({
        id: run.id,
      })
      expect(await runningRunForJob(prisma, job.id, wellAfter)).toBeUndefined()

      await finishRun(prisma, run.id)
      expect(await runningRunForJob(prisma, job.id, wellBefore)).toBeUndefined()
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

  describe("findings", () => {
    it("keeps what a run found, and survives the run finishing", async () => {
      const job = await dueJob("run-findings")
      const { runId } = await claimOrFail(job)

      const findings = {
        postings: [
          { title: "Senior Backend Engineer", url: "https://example.com/1" },
        ],
      }

      await recordRunFindings(prisma, runId, findings)
      await finishRun(prisma, runId)

      const run = await prisma.run.findUnique({ where: { id: runId } })
      expect(run?.status).toBe("succeeded")
      expect(run?.findings).toEqual(findings)
    })

    it("is NULL for a run that never wrote any", async () => {
      const job = await dueJob("no-findings")
      const { runId } = await claimOrFail(job)

      const run = await prisma.run.findUnique({ where: { id: runId } })
      expect(run?.findings).toBeNull()
    })
  })

  describe("artifacts", () => {
    it("accepts an object key in the shape user-storage builds", async () => {
      const job = await dueJob("artifact-key")
      const { runId } = await claimOrFail(job)

      const key = `prod/${userId}/briefs/2026/07/28/morning.md`
      const artifact = await recordArtifact(prisma, runId, key)

      expect(artifact.objectKey).toBe(key)
      expect(await prisma.artifact.findMany({ where: { runId } })).toHaveLength(
        1
      )
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
  })

  describe("postings", () => {
    /**
     * One briefing to hang the fixture Runs off. A Posting names a Run for
     * provenance, so every case here needs at least one — but which briefing
     * found it is not part of its identity, so one job serves them all.
     */
    let postingsJobId: string

    beforeAll(async () => {
      const job = await createJob(prisma, {
        userId,
        name: "postings-fixture",
        scheduleCron: "0 9 * * *",
      })
      postingsJobId = job.id
    })

    async function aRun(): Promise<string> {
      return (await startAdHocRun(prisma, postingsJobId)).id
    }

    /** Sixteen lowercase hex characters — the shape `postingId()` produces. */
    function derivedId(): string {
      return randomUUID().replaceAll("-", "").slice(0, 16)
    }

    function aPosting(overrides: Partial<NewPosting> = {}): NewPosting {
      return {
        postingId: derivedId(),
        title: "Senior Backend Engineer",
        company: "Example Pty Ltd",
        location: "Melbourne VIC",
        url: "https://example.com/jobs/1",
        payload: {
          highlights: ["fully remote"],
          matchReason: "Go and Postgres",
        },
        ...overrides,
      }
    }

    const FIRST_SIGHTING = new Date("2026-08-01T09:00:00.000Z")
    const SECOND_SIGHTING = new Date("2026-08-02T09:00:00.000Z")

    async function readBack(postingId: string) {
      return prisma.posting.findFirst({ where: { userId, postingId } })
    }

    it("accepts each of the three statuses and refuses a fourth", async () => {
      const runId = await aRun()
      const posting = aPosting()
      await recordPostings(prisma, {
        userId,
        runId,
        seenAt: FIRST_SIGHTING,
        postings: [posting],
      })

      for (const status of POSTING_STATUSES) {
        expect(
          await setPostingStatus(prisma, userId, posting.postingId, status)
        ).toBe(true)
      }

      // The compiler forbids a fourth, so the cast is what makes this a test of
      // the CHECK rather than of the type.
      const fourth = "archived" as string as PostingStatus

      await expect(
        setPostingStatus(prisma, userId, posting.postingId, fourth)
      ).rejects.toThrow()

      expect((await readBack(posting.postingId))?.status).toBe("rejected")
    })

    it("refuses an id that is not the shape a derived posting id takes", async () => {
      const runId = await aRun()

      // The column is an object key segment — a letter lives at
      // `…/cover-letters/{posting_id}.md` — so a value that cannot be one must
      // not be storable in the first place.
      for (const malformed of [
        "",
        "not-hex",
        "../../etc/passwd",
        "ABCDEF0123456789",
      ]) {
        await expect(
          recordPostings(prisma, {
            userId,
            runId,
            seenAt: FIRST_SIGHTING,
            postings: [aPosting({ postingId: malformed })],
          })
        ).rejects.toThrow()
      }
    })

    it("updates the one row on a second sighting, moving only the last-seen values", async () => {
      const discovered = await aRun()
      const refound = await aRun()
      const posting = aPosting()

      expect(
        await recordPostings(prisma, {
          userId,
          runId: discovered,
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })
      ).toBe(1)

      expect(
        await recordPostings(prisma, {
          userId,
          runId: refound,
          seenAt: SECOND_SIGHTING,
          postings: [{ ...posting, title: "Staff Backend Engineer" }],
        })
      ).toBe(1)

      const rows = await prisma.posting.findMany({
        where: { userId, postingId: posting.postingId },
      })
      expect(rows).toHaveLength(1)

      const row = rows[0]
      expect(row?.title).toBe("Staff Backend Engineer")
      expect(row?.firstSeenRunId).toBe(discovered)
      expect(row?.lastSeenRunId).toBe(refound)
      expect(row?.firstSeenAt.toISOString()).toBe(FIRST_SIGHTING.toISOString())
      expect(row?.lastSeenAt.toISOString()).toBe(SECOND_SIGHTING.toISOString())
    })

    it("stores the posting date, and NULL when the caller supplied none", async () => {
      const runId = await aRun()
      const dated = aPosting({ postedAt: new Date("2026-07-30T00:00:00.000Z") })
      const undated = aPosting()

      await recordPostings(prisma, {
        userId,
        runId,
        seenAt: FIRST_SIGHTING,
        postings: [dated, undated],
      })

      expect((await readBack(dated.postingId))?.postedAt?.toISOString()).toBe(
        "2026-07-30T00:00:00.000Z"
      )
      // NULL is the ordinary answer, not a defect: the scout omits the field
      // rather than estimating, and what it does say is often not a date.
      expect((await readBack(undated.postingId))?.postedAt).toBeNull()
    })

    it("re-reads the posting date on a later sighting, as it does the payload", async () => {
      // It is derived from `payload`, so it belongs to the same group of
      // columns a fresh sighting overwrites — unlike `status`, below.
      const discovered = await aRun()
      const refound = await aRun()
      const posting = aPosting({
        postedAt: new Date("2026-07-30T00:00:00.000Z"),
      })

      await recordPostings(prisma, {
        userId,
        runId: discovered,
        seenAt: FIRST_SIGHTING,
        postings: [posting],
      })

      await recordPostings(prisma, {
        userId,
        runId: refound,
        seenAt: SECOND_SIGHTING,
        postings: [
          { ...posting, postedAt: new Date("2026-08-02T00:00:00.000Z") },
        ],
      })

      expect((await readBack(posting.postingId))?.postedAt?.toISOString()).toBe(
        "2026-08-02T00:00:00.000Z"
      )
    })

    it("leaves a status the user set alone when a later run re-reports it", async () => {
      // The whole point of the feature: `status` is absent from the upsert's
      // `DO UPDATE SET` list, and this is what notices if anyone adds it.
      const discovered = await aRun()
      const refound = await aRun()
      const posting = aPosting()

      await recordPostings(prisma, {
        userId,
        runId: discovered,
        seenAt: FIRST_SIGHTING,
        postings: [posting],
      })

      expect(
        await setPostingStatus(prisma, userId, posting.postingId, "applied")
      ).toBe(true)

      await recordPostings(prisma, {
        userId,
        runId: refound,
        seenAt: SECOND_SIGHTING,
        postings: [posting],
      })

      const row = await readBack(posting.postingId)
      expect(row?.status).toBe("applied")
      expect(row?.statusChangedAt).not.toBeNull()
      // …and the sighting was still recorded, so this is not a no-op upsert.
      expect(row?.lastSeenRunId).toBe(refound)
    })

    it("does not drag the last-seen values backwards for an older sighting", async () => {
      const recent = await aRun()
      const backdated = await aRun()
      const posting = aPosting()

      await recordPostings(prisma, {
        userId,
        runId: recent,
        seenAt: SECOND_SIGHTING,
        postings: [posting],
      })

      // The backfill walks Runs oldest-first beside live traffic, so this
      // arrives after a newer sighting as a matter of course.
      expect(
        await recordPostings(prisma, {
          userId,
          runId: backdated,
          seenAt: FIRST_SIGHTING,
          postings: [{ ...posting, title: "Stale title" }],
        })
      ).toBe(0)

      const row = await readBack(posting.postingId)
      expect(row?.lastSeenAt.toISOString()).toBe(SECOND_SIGHTING.toISOString())
      expect(row?.lastSeenRunId).toBe(recent)
      expect(row?.title).toBe(posting.title)
    })

    it("merges a batch that normalises two postings to one id", async () => {
      const runId = await aRun()
      const shared = derivedId()

      // Postgres raises 21000 if one statement affects a row twice, and the
      // same advertisement reached with and without a `?ref=` is exactly what
      // `postingId()` exists to merge.
      const best = aPosting({
        postingId: shared,
        url: "https://example.com/jobs/9",
      })
      const alsoBest = aPosting({
        postingId: shared,
        title: "Same job, second link",
        url: "https://example.com/jobs/9?ref=seek",
      })

      await expect(
        recordPostings(prisma, {
          userId,
          runId,
          seenAt: FIRST_SIGHTING,
          postings: [best, alsoBest],
        })
      ).resolves.toBe(1)

      const rows = await prisma.posting.findMany({
        where: { userId, postingId: shared },
      })
      expect(rows).toHaveLength(1)
      // Findings arrive best-match first, so the first one wins.
      expect(rows[0]?.title).toBe(best.title)
      expect(rows[0]?.url).toBe(best.url)
    })

    it("reports no match when the posting belongs to someone else", async () => {
      const runId = await aRun()
      const posting = aPosting()
      await recordPostings(prisma, {
        userId,
        runId,
        seenAt: FIRST_SIGHTING,
        postings: [posting],
      })

      const stranger = await ensureUserForAuth(prisma, `auth_${randomUUID()}`)

      expect(
        await setPostingStatus(
          prisma,
          stranger.id,
          posting.postingId,
          "rejected"
        )
      ).toBe(false)

      const row = await readBack(posting.postingId)
      expect(row?.status).toBe("new")
      expect(row?.statusChangedAt).toBeNull()
    })

    it("refuses to delete a run a posting still names", async () => {
      const runId = await aRun()
      await recordPostings(prisma, {
        userId,
        runId,
        seenAt: FIRST_SIGHTING,
        postings: [aPosting()],
      })

      await expect(
        admin.query(`delete from "${SCHEMA}".runs where id = $1`, [runId])
      ).rejects.toThrow()
    })

    it("deletes only the ids named, and only the caller's rows", async () => {
      const runId = await aRun()
      const doomed = aPosting()
      const spared = aPosting()

      await recordPostings(prisma, {
        userId,
        runId,
        seenAt: FIRST_SIGHTING,
        postings: [doomed, spared],
      })

      const stranger = await ensureUserForAuth(prisma, `auth_${randomUUID()}`)

      // The stranger names a real Posting id — they are derived from a public
      // URL, so anyone reading the same board can produce one — and reaches
      // nothing, because `user_id` is the other half of the key.
      expect(
        await ownedPostingIds(prisma, stranger.id, [doomed.postingId])
      ).toEqual([])
      expect(
        await deletePostings(prisma, stranger.id, [doomed.postingId])
      ).toBe(0)
      expect(await readBack(doomed.postingId)).not.toBeNull()

      expect(await ownedPostingIds(prisma, userId, [doomed.postingId])).toEqual(
        [doomed.postingId]
      )
      expect(await deletePostings(prisma, userId, [doomed.postingId])).toBe(1)

      expect(await readBack(doomed.postingId)).toBeNull()
      expect(await readBack(spared.postingId)).not.toBeNull()
    })

    it("deletes a whole selection in one statement", async () => {
      const runId = await aRun()
      const postings = [aPosting(), aPosting(), aPosting()]

      await recordPostings(prisma, {
        userId,
        runId,
        seenAt: FIRST_SIGHTING,
        postings,
      })

      const ids = postings.map((posting) => posting.postingId)

      expect(await deletePostings(prisma, userId, ids)).toBe(3)
      expect(await ownedPostingIds(prisma, userId, ids)).toEqual([])
    })

    /**
     * ⚠️ **The delete is from the page, not from the search, and this pins
     * that.** `recordPostings` upserts on `(user_id, posting_id)` and knows
     * nothing about a Posting having been removed, so a Briefing that still
     * matches the advertisement brings it back at `new`. Intended behaviour
     * rather than a gap — a tombstone would be a schema decision — and the
     * confirmation dialog says so in words. If this test ever starts failing,
     * something added that tombstone; the copy has to change with it.
     */
    it("lets a later run re-record a deleted posting, at new", async () => {
      const posting = aPosting()

      await recordPostings(prisma, {
        userId,
        runId: await aRun(),
        seenAt: FIRST_SIGHTING,
        postings: [posting],
      })
      await setPostingStatus(prisma, userId, posting.postingId, "applied")
      await deletePostings(prisma, userId, [posting.postingId])

      await recordPostings(prisma, {
        userId,
        runId: await aRun(),
        seenAt: SECOND_SIGHTING,
        postings: [posting],
      })

      const reappeared = await readBack(posting.postingId)

      expect(reappeared).not.toBeNull()
      expect(reappeared?.status).toBe("new")
      expect(reappeared?.statusChangedAt).toBeNull()
    })

    it("takes an empty list as nothing to do, without a query", async () => {
      expect(await ownedPostingIds(prisma, userId, [])).toEqual([])
      expect(await deletePostings(prisma, userId, [])).toBe(0)
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

  describe("cover letter instructions", () => {
    it("reads nothing for a user who has never saved any", async () => {
      const fresh = await prisma.user.create({ data: {} })

      expect(await coverLetterInstructions(prisma, fresh.id)).toBeUndefined()
    })

    it("creates the row on the first save", async () => {
      const fresh = await prisma.user.create({ data: {} })

      const saved = await saveCoverLetterInstructions(prisma, fresh.id, {
        instructions: 'Never use the word "passionate".',
        exampleLetter: "Dear Hiring Team,",
      })

      expect(saved.userId).toBe(fresh.id)
      expect(await coverLetterInstructions(prisma, fresh.id)).toEqual(saved)
    })

    it("updates the row on a second save rather than adding one", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await saveCoverLetterInstructions(prisma, fresh.id, {
        instructions: "Australian spelling.",
        exampleLetter: "",
      })
      await saveCoverLetterInstructions(prisma, fresh.id, {
        instructions: 'Sign off "Kind regards".',
        exampleLetter: "Dear Hiring Team,",
      })

      const row = await coverLetterInstructions(prisma, fresh.id)
      expect(row?.instructions).toBe('Sign off "Kind regards".')
      expect(row?.exampleLetter).toBe("Dear Hiring Team,")

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".cover_letter_instructions where user_id = $1`,
        [fresh.id]
      )
      expect(rows[0]?.count).toBe("1")
    })

    it("moves updated_at forward on the second save", async () => {
      const fresh = await prisma.user.create({ data: {} })

      const first = await saveCoverLetterInstructions(prisma, fresh.id, {
        instructions: "Open with why the role.",
        exampleLetter: "",
      })
      const second = await saveCoverLetterInstructions(prisma, fresh.id, {
        instructions: "Open with why the company.",
        exampleLetter: "",
      })

      expect(second.updatedAt.getTime()).toBeGreaterThan(
        first.updatedAt.getTime()
      )
    })

    it("stores empty strings rather than nulls when nothing is set", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await saveCoverLetterInstructions(prisma, fresh.id, {
        instructions: "",
        exampleLetter: "",
      })

      const row = await coverLetterInstructions(prisma, fresh.id)
      expect(row?.instructions).toBe("")
      expect(row?.exampleLetter).toBe("")

      const { rows } = await admin.query<{
        instructions: string | null
        example_letter: string | null
      }>(
        `select instructions, example_letter from "${SCHEMA}".cover_letter_instructions where user_id = $1`,
        [fresh.id]
      )
      expect(rows[0]?.instructions).toBe("")
      expect(rows[0]?.example_letter).toBe("")
    })

    it("goes with the user, which is the whole point of the cascade", async () => {
      const doomed = await prisma.user.create({ data: {} })
      await saveCoverLetterInstructions(prisma, doomed.id, {
        instructions: "Delete me with my user.",
        exampleLetter: "",
      })

      await admin.query(`delete from "${SCHEMA}".users where id = $1`, [
        doomed.id,
      ])

      expect(await coverLetterInstructions(prisma, doomed.id)).toBeUndefined()
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
