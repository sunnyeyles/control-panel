import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  claimAdHocRun,
  claimJob,
  countUnmatchedPostings,
  coverLetterInstructions,
  createJob,
  createPrismaClient,
  deleteDocument,
  deletePostings,
  DOCUMENT_TYPES,
  dueJobs,
  ensureUserForAuth,
  failRun,
  findDocument,
  finishRun,
  latestRunPerJob,
  listDocumentsForUser,
  listPostingPage,
  listUnmatchedPostingIds,
  loadBoard,
  pauseJob,
  POSTING_STATUSES,
  ownedPostingIds,
  postingFilters,
  postingPayload,
  recordDocument,
  recordArtifact,
  recordLinkedPosting,
  recordPostingMatch,
  recordPostings,
  recordRunFindings,
  resumeJob,
  runningRunForJob,
  saveBoard,
  saveCoverLetterInstructions,
  savePostingFilters,
  setPostingStatus,
  startAdHocRun,
  titleExclusions,
  updateJobSchedule,
  type DocumentType,
  type DueJob,
  type NewDocument,
  type NewPosting,
  type PostingPageQuery,
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

    /**
     * The second writer, and every case here is about what it must *not* do.
     *
     * `recordLinkedPosting` exists because a Posting the user pasted has no Run
     * behind it, but the reason it is a separate function rather than a flag on
     * `recordPostings` is its `ON CONFLICT DO NOTHING`: a link may create a
     * Posting and may never revise one. Each assertion below is a way that
     * could silently stop being true.
     */
    describe("added by link", () => {
      it("records a posting with no run at either end", async () => {
        const posting = aPosting()

        expect(
          await recordLinkedPosting(prisma, {
            userId,
            seenAt: FIRST_SIGHTING,
            posting,
          })
        ).toBe(true)

        const row = await readBack(posting.postingId)

        // NULL in both is the whole of how a link-added Posting is
        // distinguishable from a found one. There is no `source` column.
        expect(row?.firstSeenRunId).toBeNull()
        expect(row?.lastSeenRunId).toBeNull()
        expect(row?.status).toBe("new")
        expect(row?.firstSeenAt.toISOString()).toBe(
          FIRST_SIGHTING.toISOString()
        )
      })

      it("answers false for an advertisement already tracked, and changes nothing", async () => {
        const discovered = await aRun()
        const posting = aPosting()

        await recordPostings(prisma, {
          userId,
          runId: discovered,
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })
        await setPostingStatus(prisma, userId, posting.postingId, "applied")

        expect(
          await recordLinkedPosting(prisma, {
            userId,
            seenAt: SECOND_SIGHTING,
            posting: { ...posting, title: "Something Else Entirely" },
          })
        ).toBe(false)

        const row = await readBack(posting.postingId)

        // ⚠️ The three losses `DO NOTHING` prevents, in order: a status a
        // person set walked back to `new`, a Run's provenance blanked by a
        // path that has none, and a Run-written payload swapped for a thinner
        // one.
        expect(row?.status).toBe("applied")
        expect(row?.lastSeenRunId).toBe(discovered)
        expect(row?.title).toBe("Senior Backend Engineer")
      })

      it("lets a later Run claim the sighting without claiming the discovery", async () => {
        const refound = await aRun()
        const posting = aPosting()

        await recordLinkedPosting(prisma, {
          userId,
          seenAt: FIRST_SIGHTING,
          posting,
        })

        await recordPostings(prisma, {
          userId,
          runId: refound,
          seenAt: SECOND_SIGHTING,
          postings: [posting],
        })

        const row = await readBack(posting.postingId)

        // "You found this one yourself, and a briefing has since found it too."
        // `first_seen_run_id` is absent from the upsert's DO UPDATE SET list,
        // so it stays NULL rather than being backfilled with the Run that
        // merely re-found it.
        expect(row?.firstSeenRunId).toBeNull()
        expect(row?.lastSeenRunId).toBe(refound)
        expect(row?.lastSeenAt.toISOString()).toBe(
          SECOND_SIGHTING.toISOString()
        )
      })

      it("refuses an id that is not the shape a derived posting id takes", async () => {
        // The CHECK applies to this path too: the value is still an object key
        // segment, and a second writer is a second way past a constraint if it
        // is not tested for.
        await expect(
          recordLinkedPosting(prisma, {
            userId,
            seenAt: FIRST_SIGHTING,
            posting: aPosting({ postingId: "../../etc/passwd" }),
          })
        ).rejects.toThrow()
      })
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

    describe("the match against a resume", () => {
      const RESUME_ID = "3f8d1b2a-0000-4000-8000-0000000000c1"
      const OTHER_RESUME_ID = "3f8d1b2a-0000-4000-8000-0000000000c2"
      const MATCHED_AT = new Date("2026-08-03T09:00:00.000Z")

      async function aScoredPosting(resumeId = RESUME_ID) {
        const posting = aPosting()

        await recordPostings(prisma, {
          userId,
          runId: await aRun(),
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })

        expect(
          await recordPostingMatch(prisma, {
            userId,
            postingId: posting.postingId,
            score: 82,
            reason: "The CV evidences the stack this role names.",
            gaps: ["Kubernetes in production"],
            resumeId,
            matchedAt: MATCHED_AT,
          })
        ).toBe(true)

        return posting
      }

      it("records all five columns and reads them back together", async () => {
        const posting = await aScoredPosting()

        expect(
          await postingPayload(prisma, userId, posting.postingId)
        ).toMatchObject({
          match: {
            score: 82,
            reason: "The CV evidences the stack this role names.",
            gaps: ["Kubernetes in production"],
            resumeId: RESUME_ID,
            matchedAt: MATCHED_AT,
          },
        })
      })

      /**
       * ⚠️ **The reason the five are columns rather than payload keys, and the
       * exact analogue of the `status` test above.** A Briefing on a daily
       * cadence re-finds the advertisements it already found, so a `DO UPDATE
       * SET` list that named any of these would blank every score on a
       * schedule, with no error and no trace. `turbo test` alone cannot catch
       * that — this file skips itself without `DATABASE_URL_UNPOOLED`.
       */
      it("survives a later run re-reporting the same advertisement", async () => {
        const posting = await aScoredPosting()
        const refound = await aRun()

        await recordPostings(prisma, {
          userId,
          runId: refound,
          seenAt: SECOND_SIGHTING,
          postings: [posting],
        })

        const row = await readBack(posting.postingId)
        expect(row?.matchScore).toBe(82)
        expect(row?.matchResumeId).toBe(RESUME_ID)
        expect(row?.matchedAt?.toISOString()).toBe(MATCHED_AT.toISOString())
        // …and the sighting was still recorded, so this is not a no-op upsert.
        expect(row?.lastSeenRunId).toBe(refound)
      })

      it("refuses a score outside 0 to 100", async () => {
        const posting = aPosting()
        await recordPostings(prisma, {
          userId,
          runId: await aRun(),
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })

        await expect(
          recordPostingMatch(prisma, {
            userId,
            postingId: posting.postingId,
            score: 101,
            reason: "Out of range.",
            gaps: [],
            resumeId: RESUME_ID,
            matchedAt: MATCHED_AT,
          })
        ).rejects.toThrow()
      })

      /**
       * A score nobody can date or attribute to a document is not a score. The
       * CHECK is what makes "all five or none" a property of the table rather
       * than of whichever caller wrote the row last.
       */
      it("refuses a half-written match", async () => {
        const posting = aPosting()
        await recordPostings(prisma, {
          userId,
          runId: await aRun(),
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })

        await expect(
          prisma.posting.updateMany({
            where: { userId, postingId: posting.postingId },
            data: { matchScore: 70 },
          })
        ).rejects.toThrow()
      })

      it("never inserts a Posting that is not already there", async () => {
        expect(
          await recordPostingMatch(prisma, {
            userId,
            postingId: derivedId(),
            score: 50,
            reason: "Nothing to attach this to.",
            gaps: [],
            resumeId: RESUME_ID,
            matchedAt: MATCHED_AT,
          })
        ).toBe(false)
      })

      /**
       * ⚠️ **Both arms of the staleness predicate, in one test.** A Posting
       * nobody has scored has `match_resume_id` NULL and a plain `<>` would
       * exclude it — which would make the unscored rows invisible to the one
       * query whose job is to find them. A Posting scored against a CV the user
       * has replaced carries some other id and wants scoring again.
       */
      it("lists the never-scored and the scored-against-something-else", async () => {
        const unscored = aPosting()
        await recordPostings(prisma, {
          userId,
          runId: await aRun(),
          seenAt: FIRST_SIGHTING,
          postings: [unscored],
        })

        const stale = await aScoredPosting(OTHER_RESUME_ID)
        const current = await aScoredPosting(RESUME_ID)

        const pending = await listUnmatchedPostingIds(
          prisma,
          userId,
          RESUME_ID,
          100
        )

        expect(pending).toContain(unscored.postingId)
        expect(pending).toContain(stale.postingId)
        expect(pending).not.toContain(current.postingId)
        expect(await countUnmatchedPostings(prisma, userId, RESUME_ID)).toBe(
          pending.length
        )
      })

      it("bounds the batch it hands back", async () => {
        for (let index = 0; index < 3; index += 1) {
          await recordPostings(prisma, {
            userId,
            runId: await aRun(),
            seenAt: FIRST_SIGHTING,
            postings: [aPosting()],
          })
        }

        expect(
          await listUnmatchedPostingIds(prisma, userId, RESUME_ID, 2)
        ).toHaveLength(2)
        // A caller that asked for nothing is asking no question, and must not
        // be answered with the whole table.
        expect(
          await listUnmatchedPostingIds(prisma, userId, RESUME_ID, 0)
        ).toEqual([])
      })

      it("cannot be written through another user's id", async () => {
        const posting = await aScoredPosting()
        const stranger = await ensureUserForAuth(prisma, `auth_${randomUUID()}`)

        expect(
          await recordPostingMatch(prisma, {
            userId: stranger.id,
            postingId: posting.postingId,
            score: 5,
            reason: "Somebody else's row.",
            gaps: [],
            resumeId: RESUME_ID,
            matchedAt: MATCHED_AT,
          })
        ).toBe(false)

        expect((await readBack(posting.postingId))?.matchScore).toBe(82)
      })
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

    /**
     * ⚠️ **The read two Posting Document actions and the detail panel write
     * from.** Everything downstream of it — a cover letter, a tailored resume —
     * is text put in the user's own name, so "can this be reached by naming
     * somebody else's id" is the question worth asking against a real index
     * rather than against a fake that agrees with whoever wrote it.
     */
    describe("reading the stored payload", () => {
      it("hands back the payload and the run that last saw it", async () => {
        const runId = await aRun()
        const posting = aPosting()
        await recordPostings(prisma, {
          userId,
          runId,
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })

        expect(await postingPayload(prisma, userId, posting.postingId)).toEqual(
          // `match: null` because a Run cannot write one — the worker holds no
          // grant on the resumes it would be scored against. See `0011`.
          { payload: posting.payload, lastSeenRunId: runId, match: null }
        )
      })

      it("cannot be reached with another user's id", async () => {
        const runId = await aRun()
        const posting = aPosting()
        await recordPostings(prisma, {
          userId,
          runId,
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })

        const stranger = await ensureUserForAuth(prisma, `auth_${randomUUID()}`)

        // The same `undefined` a Posting nobody has produces, and deliberately
        // so: Posting ids are derived from an advertisement's URL, so a caller
        // able to tell the two apart would be an oracle for whether a stranger
        // has been shown one.
        expect(
          await postingPayload(prisma, stranger.id, posting.postingId)
        ).toBeUndefined()
        expect(
          await postingPayload(prisma, userId, derivedId())
        ).toBeUndefined()
      })

      it("follows the payload the newest sighting wrote", async () => {
        // `recordPostings` re-reads `payload` on every sighting that is not
        // older than the last, so this read must not be answered from a cached
        // or first-seen copy.
        const posting = aPosting()
        await recordPostings(prisma, {
          userId,
          runId: await aRun(),
          seenAt: FIRST_SIGHTING,
          postings: [posting],
        })

        const refound = await aRun()
        await recordPostings(prisma, {
          userId,
          runId: refound,
          seenAt: SECOND_SIGHTING,
          postings: [{ ...posting, payload: { matchReason: "rewritten" } }],
        })

        expect(await postingPayload(prisma, userId, posting.postingId)).toEqual(
          {
            payload: { matchReason: "rewritten" },
            lastSeenRunId: refound,
            match: null,
          }
        )
      })
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

    /**
     * One page of the table, against a real index and a real planner.
     *
     * ⚠️ **These are the assertions that could not be written before
     * `listPostingPage` existed.** The dashboard's suite ran the ordering
     * against JavaScript somebody wrote to match what Postgres was believed to
     * do — so "NULLS LAST in both directions" and "a row cannot appear on two
     * pages" were checked against the belief rather than against the database.
     * A tie-break at a page boundary in particular is unfalsifiable that way: a
     * fake that sorts a stable array has no ties to break.
     *
     * Each block seeds **its own user**, because the postings above accumulate
     * across this file and `total` is a count of everything one user has. That
     * also makes every `total` here an assertion that a second user's rows —
     * which the shared `userId` certainly has by now — are not counted.
     */
    describe("reading a page", () => {
      /** Two ends of the alphabet per column, so no two orders agree. */
      const ORDERED = [
        { title: "Alpha", company: "Zulu", posted: "2026-07-01" },
        { title: "Bravo", company: "Yankee", posted: undefined },
        { title: "Charlie", company: "X-ray", posted: "2026-07-03" },
        { title: "Delta", company: "Whisky", posted: "2026-07-02" },
      ] as const

      /** One sighting per row, ascending, so `lastSeenAt` orders them too. */
      const SIGHTINGS = [
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z"),
        new Date("2026-08-03T00:00:00.000Z"),
        new Date("2026-08-04T00:00:00.000Z"),
      ]

      let readerId: string

      async function freshUser(): Promise<string> {
        return (await ensureUserForAuth(prisma, `auth_${randomUUID()}`)).id
      }

      function page(
        forUser: string,
        overrides: Partial<PostingPageQuery> = {}
      ) {
        return listPostingPage(prisma, forUser, {
          order: "lastSeenAt",
          direction: "desc",
          page: 1,
          pageSize: 25,
          ...overrides,
        })
      }

      const titles = (result: { rows: { title: string }[] }) =>
        result.rows.map((row) => row.title)

      beforeAll(async () => {
        readerId = await freshUser()

        for (const [index, row] of ORDERED.entries()) {
          await recordPostings(prisma, {
            userId: readerId,
            runId: await aRun(),
            seenAt: SIGHTINGS[index] as Date,
            postings: [
              aPosting({
                title: row.title,
                company: row.company,
                ...(row.posted ? { postedAt: new Date(row.posted) } : {}),
              }),
            ],
          })
        }
      })

      it("orders by each column, both ways", async () => {
        expect(titles(await page(readerId, { order: "lastSeenAt" }))).toEqual([
          "Delta",
          "Charlie",
          "Bravo",
          "Alpha",
        ])
        expect(
          titles(
            await page(readerId, { order: "lastSeenAt", direction: "asc" })
          )
        ).toEqual(["Alpha", "Bravo", "Charlie", "Delta"])

        expect(
          titles(await page(readerId, { order: "title", direction: "asc" }))
        ).toEqual(["Alpha", "Bravo", "Charlie", "Delta"])
        expect(titles(await page(readerId, { order: "title" }))).toEqual([
          "Delta",
          "Charlie",
          "Bravo",
          "Alpha",
        ])

        // Company runs the opposite way to title, which is what makes this an
        // assertion about the column rather than about insertion order.
        expect(
          titles(await page(readerId, { order: "company", direction: "asc" }))
        ).toEqual(["Delta", "Charlie", "Bravo", "Alpha"])
        expect(titles(await page(readerId, { order: "company" }))).toEqual([
          "Alpha",
          "Bravo",
          "Charlie",
          "Delta",
        ])
      })

      it("keeps a stated-no-date row at the bottom whichever way posted runs", async () => {
        // ⚠️ NULLS LAST in *both* directions. Bravo stated no date, and Postgres
        // would default to putting it first under DESC — every row that says
        // nothing above every row that says something.
        expect(titles(await page(readerId, { order: "postedAt" }))).toEqual([
          "Charlie",
          "Delta",
          "Alpha",
          "Bravo",
        ])
        expect(
          titles(await page(readerId, { order: "postedAt", direction: "asc" }))
        ).toEqual(["Alpha", "Delta", "Charlie", "Bravo"])
      })

      it("names the briefing that last found each row", async () => {
        const { rows } = await page(readerId)

        // Flattened out of `last_seen_run_id` → `runs.job_id` → `jobs.name` by
        // the query, so no caller is handed a nested relation to walk.
        expect(rows.map((row) => row.briefing)).toEqual(
          rows.map(() => "postings-fixture")
        )
      })

      it("counts only this user's rows", async () => {
        const {
          total,
          pageCount,
          page: rendered,
        } = await page(readerId, {
          pageSize: 3,
        })

        expect(total).toBe(ORDERED.length)
        expect(pageCount).toBe(2)
        expect(rendered).toBe(1)
      })

      it("renders the last page for one past the end", async () => {
        // Not an empty page with working controls under it: the page asked for
        // is clamped to the real page count, which only the count knows.
        const result = await page(readerId, { pageSize: 3, page: 99 })

        expect(result.page).toBe(2)
        expect(result.rows).toHaveLength(1)
      })

      it("answers page one for a user with nothing", async () => {
        const empty = await page(await freshUser())

        expect(empty).toEqual({
          rows: [],
          total: 0,
          hidden: 0,
          page: 1,
          pageCount: 1,
        })
      })

      it("shows no row twice across a boundary when the sort column ties", async () => {
        // ⚠️ **The single best reason this function exists.** Thirty rows
        // recorded by one statement share a `last_seen_at` exactly, so offset
        // pagination over `last_seen_at` alone lets the planner choose freely
        // among equal rows — the same row can land on page 1 and page 2 while
        // another lands on neither. The `postingId` tie-break is what forbids
        // it, and nothing that sorts a JavaScript array can be made to fail
        // this.
        const tiedId = await freshUser()
        const tied = Array.from({ length: 30 }, () => aPosting())

        await recordPostings(prisma, {
          userId: tiedId,
          runId: await aRun(),
          seenAt: FIRST_SIGHTING,
          postings: tied,
        })

        const seen: string[] = []
        for (const which of [1, 2, 3]) {
          const { rows } = await page(tiedId, { pageSize: 10, page: which })
          expect(rows).toHaveLength(10)
          seen.push(...rows.map((row) => row.postingId))
        }

        expect(new Set(seen).size).toBe(30)
        expect(new Set(seen)).toEqual(
          new Set(tied.map((posting) => posting.postingId))
        )
      })

      /**
       * The title filter, against the generated column rather than against a
       * belief about it.
       *
       * ⚠️ **This is the half of the rule that only Postgres can answer.**
       * `normalizeTitle()` in `@workspace/job-search` is unit-tested next door,
       * but `title_normalized` is `GENERATED ALWAYS … STORED` in `0010` and
       * restates that rule in SQL — so whether the two agree is a property of
       * this database and of nothing a fake could be made to disagree with.
       * Every case below is one where a naive substring filter gets a
       * different answer.
       */
      describe("filtering by a word in the title", () => {
        const TITLED = [
          "Senior Backend Engineer",
          "Backend Engineer",
          "Seniority Partners Analyst",
          "HTML Developer",
          "Staff/Senior Platform Engineer",
        ] as const

        let filteredId: string

        beforeAll(async () => {
          filteredId = await freshUser()

          await recordPostings(prisma, {
            userId: filteredId,
            runId: await aRun(),
            seenAt: FIRST_SIGHTING,
            postings: TITLED.map((title) => aPosting({ title })),
          })
        })

        it("removes a whole-word match wherever the punctuation falls", async () => {
          const result = await page(filteredId, {
            order: "title",
            direction: "asc",
            excludeTitlePatterns: [" senior "],
          })

          // "Staff/Senior Platform Engineer" goes because the slash flattens to
          // a space — the case a `LIKE '% senior %'` on the raw title misses.
          expect(titles(result).sort()).toEqual([
            "Backend Engineer",
            "HTML Developer",
            "Seniority Partners Analyst",
          ])
        })

        it("keeps a row where the word is only a substring", async () => {
          // The whole reason the column is padded. A substring filter would
          // take "Seniority Partners Analyst" out with the senior roles, and
          // `ml` would empty the table of every HTML role — silently, because
          // the row simply would not be there to notice.
          const bySubstring = await page(filteredId, {
            excludeTitlePatterns: [" ml "],
          })

          expect(titles(bySubstring)).toContain("HTML Developer")
          expect(bySubstring.total).toBe(TITLED.length)
          expect(bySubstring.hidden).toBe(0)
        })

        it("counts the filtered set, and reports what it left out", async () => {
          const result = await page(filteredId, {
            pageSize: 2,
            excludeTitlePatterns: [" senior "],
          })

          // ⚠️ `total` and `pageCount` describe the rows actually shown — a
          // total that counted hidden rows would paginate past the end — while
          // `hidden` is the separate fact the table has to say out loud.
          expect(result.total).toBe(3)
          expect(result.pageCount).toBe(2)
          expect(result.hidden).toBe(2)
        })

        it("takes several patterns as any-of", async () => {
          const result = await page(filteredId, {
            excludeTitlePatterns: [" senior ", " html developer "],
          })

          expect(titles(result).sort()).toEqual([
            "Backend Engineer",
            "Seniority Partners Analyst",
          ])
        })

        it("filters nothing, and counts nothing hidden, without patterns", async () => {
          for (const patterns of [undefined, []]) {
            const result = await page(filteredId, {
              ...(patterns ? { excludeTitlePatterns: patterns } : {}),
            })

            expect(result.total).toBe(TITLED.length)
            expect(result.hidden).toBe(0)
          }
        })

        it("still scopes to the user asking", async () => {
          // The exclusion is added beside `where: { userId }`, never in place
          // of it — a filter must not become the ownership check.
          const stranger = await page(await freshUser(), {
            excludeTitlePatterns: [" senior "],
          })

          expect(stranger.rows).toEqual([])
          expect(stranger.total).toBe(0)
        })
      })
    })
  })

  describe("posting filters", () => {
    it("reads an empty list for a user who has never saved one", async () => {
      const fresh = await prisma.user.create({ data: {} })

      // A missing row and an empty list are different things — the first is
      // still `undefined` — but both filter nothing, which is what lets every
      // enforcer read `titleExclusions` and never branch.
      expect(await postingFilters(prisma, fresh.id)).toBeUndefined()
      expect(await titleExclusions(prisma, fresh.id)).toEqual([])
    })

    it("creates the row on the first save and reads it back", async () => {
      const fresh = await prisma.user.create({ data: {} })

      const saved = await savePostingFilters(prisma, fresh.id, {
        titleExclusions: ["senior", "tech lead"],
      })

      expect(saved.userId).toBe(fresh.id)
      expect(await titleExclusions(prisma, fresh.id)).toEqual([
        "senior",
        "tech lead",
      ])
    })

    it("replaces the list on a second save rather than adding to it", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await savePostingFilters(prisma, fresh.id, {
        titleExclusions: ["senior", "principal"],
      })
      await savePostingFilters(prisma, fresh.id, { titleExclusions: [] })

      // A save is the whole setting, not a patch of it, so clearing the field
      // is an ordinary save and not its own operation.
      expect(await titleExclusions(prisma, fresh.id)).toEqual([])

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".posting_filters where user_id = $1`,
        [fresh.id]
      )
      expect(rows[0]?.count).toBe("1")
    })

    it("refuses a list longer than the bound", async () => {
      const fresh = await prisma.user.create({ data: {} })

      // The backstop for every path that does not go through the form, which
      // is where `MAX_TITLE_EXCLUSIONS` produces the message a user reads.
      await expect(
        savePostingFilters(prisma, fresh.id, {
          titleExclusions: Array.from({ length: 51 }, (_, at) => `term${at}`),
        })
      ).rejects.toThrow()
    })

    it("goes when the user does", async () => {
      // Cascades, unlike almost everything else here: a preference with no
      // independent existence must not make a user undeletable.
      const fresh = await prisma.user.create({ data: {} })
      await savePostingFilters(prisma, fresh.id, {
        titleExclusions: ["senior"],
      })

      await prisma.user.delete({ where: { id: fresh.id } })

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".posting_filters where user_id = $1`,
        [fresh.id]
      )
      expect(rows[0]?.count).toBe("0")
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

  describe("documents", () => {
    let index = 0

    /** A row whose id is a fresh uuid, because the id is not defaulted here. */
    function aDocument(overrides: Partial<NewDocument> = {}): NewDocument {
      index += 1

      return {
        id: randomUUID(),
        userId,
        extension: ".pdf",
        filename: `cv-${index}.pdf`,
        docType: "resume",
        byteSize: 1024,
        ...overrides,
      }
    }

    it("round-trips a document and reads it back by owner", async () => {
      const written = await recordDocument(prisma, aDocument())

      const read = await findDocument(prisma, userId, written.id)

      expect(read).toMatchObject({
        id: written.id,
        userId,
        extension: ".pdf",
        docType: "resume",
        byteSize: 1024,
      })
    })

    it("keeps a filename S3 user metadata could not have carried", async () => {
      // The reason this column exists. A metadata value travels as an HTTP
      // header, so `toMetadataValue` strips it to printable ASCII; `text` does
      // not, which is why the filename moved here and not the other way.
      const written = await recordDocument(
        prisma,
        aDocument({ filename: "Lebenslauf – 2026 ✅.pdf" })
      )

      expect((await findDocument(prisma, userId, written.id))?.filename).toBe(
        "Lebenslauf – 2026 ✅.pdf"
      )
    })

    it("accepts each of the six document types and refuses a seventh", async () => {
      for (const docType of DOCUMENT_TYPES) {
        const written = await recordDocument(prisma, aDocument({ docType }))
        expect((await findDocument(prisma, userId, written.id))?.docType).toBe(
          docType
        )
      }

      // The compiler forbids a seventh, so the cast is what makes this a test
      // of the CHECK rather than of the type.
      const seventh = "diploma" as string as DocumentType

      await expect(
        recordDocument(prisma, aDocument({ docType: seventh }))
      ).rejects.toThrow()
    })

    it("refuses an extension that could not be part of an object key", async () => {
      // `documents_extension_check` mirrors `EXTENSION_SOURCE` in
      // `@workspace/user-storage/keys`. A row holding one of these would
      // address an object nothing could ever have written.
      for (const extension of ["", "pdf", ".PDF", ".p df", "../etc", ".pdf."]) {
        await expect(
          recordDocument(prisma, aDocument({ extension }))
        ).rejects.toThrow()
      }
    })

    it("refuses an empty filename and a negative size", async () => {
      await expect(
        recordDocument(prisma, aDocument({ filename: "" }))
      ).rejects.toThrow()

      await expect(
        recordDocument(prisma, aDocument({ byteSize: -1 }))
      ).rejects.toThrow()
    })

    it("defaults an unspecified type to `other` rather than to NULL", async () => {
      const id = randomUUID()

      await prisma.$executeRaw`
        INSERT INTO documents (id, user_id, extension, filename, byte_size)
        VALUES (${id}::uuid, ${userId}::uuid, '.pdf', 'unlabelled.pdf', 1)
      `

      expect((await findDocument(prisma, userId, id))?.docType).toBe("other")
    })

    it("lists newest first, tie-broken so a row cannot move between reads", async () => {
      const owner = await prisma.user.create({ data: {} })
      const at = (iso: string) => new Date(iso)

      const older = await recordDocument(
        prisma,
        aDocument({ userId: owner.id }),
        at("2026-01-01T00:00:00.000Z")
      )
      const newest = await recordDocument(
        prisma,
        aDocument({ userId: owner.id }),
        at("2026-07-01T00:00:00.000Z")
      )
      const middle = await recordDocument(
        prisma,
        aDocument({ userId: owner.id }),
        at("2026-04-01T00:00:00.000Z")
      )

      const listed = await listDocumentsForUser(prisma, owner.id)

      expect(listed.map((row) => row.id)).toEqual([
        newest.id,
        middle.id,
        older.id,
      ])
    })

    it("does not read or delete another user's document", async () => {
      // ⚠️ The `userId` filter is the *whole* ownership check on both calls —
      // there is nothing underneath it the way `assertOwnedBy` sits under the
      // object store. Dropping it would be invisible without this.
      const stranger = await prisma.user.create({ data: {} })
      const mine = await recordDocument(prisma, aDocument())

      expect(await findDocument(prisma, stranger.id, mine.id)).toBeUndefined()
      expect(await deleteDocument(prisma, stranger.id, mine.id)).toBe(false)
      expect(await findDocument(prisma, userId, mine.id)).toBeDefined()
    })

    it("reports whether a delete found anything, rather than throwing", async () => {
      const written = await recordDocument(prisma, aDocument())

      expect(await deleteDocument(prisma, userId, written.id)).toBe(true)
      // The second call is the ordinary case, not an error: two tabs, one
      // document. `deleteMany` is what makes it an answer instead of a throw.
      expect(await deleteDocument(prisma, userId, written.id)).toBe(false)
      expect(await findDocument(prisma, userId, written.id)).toBeUndefined()
    })

    it("refuses two documents with the same id", async () => {
      // The id is also the S3 key segment, so a duplicate would mean two rows
      // claiming the same object.
      const written = await recordDocument(prisma, aDocument())

      await expect(
        recordDocument(prisma, aDocument({ id: written.id }))
      ).rejects.toThrow()
    })
  })

  describe("boards", () => {
    it("reads nothing for a user who has never drawn one", async () => {
      const fresh = await prisma.user.create({ data: {} })

      expect(await loadBoard(prisma, fresh.id)).toBeUndefined()
    })

    it("round-trips a snapshot unchanged, because it is opaque here", async () => {
      const fresh = await prisma.user.create({ data: {} })
      const snapshot = {
        document: {
          store: { "shape:s1": { x: 0, y: -12.5, nested: [1, null] } },
        },
        session: { currentPageId: "page:page" },
      }

      await saveBoard(prisma, fresh.id, snapshot)

      expect(await loadBoard(prisma, fresh.id)).toEqual(snapshot)
    })

    it("replaces the snapshot whole rather than merging into it", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await saveBoard(prisma, fresh.id, { document: { store: { a: 1 } } })
      await saveBoard(prisma, fresh.id, { document: { store: { b: 2 } } })

      // A board is a picture, not a patch of one — `a` must be gone.
      expect(await loadBoard(prisma, fresh.id)).toEqual({
        document: { store: { b: 2 } },
      })
    })

    it("keeps at most one row per user, which the primary key enforces", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await saveBoard(prisma, fresh.id, { n: 1 })
      await saveBoard(prisma, fresh.id, { n: 2 })

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".boards where user_id = $1`,
        [fresh.id]
      )
      expect(rows[0]?.count).toBe("1")
    })

    it("goes with the user, which is the whole point of the cascade", async () => {
      const doomed = await prisma.user.create({ data: {} })
      await saveBoard(prisma, doomed.id, { n: 1 })

      await admin.query(`delete from "${SCHEMA}".users where id = $1`, [
        doomed.id,
      ])

      expect(await loadBoard(prisma, doomed.id)).toBeUndefined()
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
