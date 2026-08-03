import type { Posting } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
import type { PrismaClient } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { latestPostingsForUser } from "./latest-postings"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"

/** Rows the fake holds, in the shape the query selects them back out. */
interface JobRow {
  id: string
  userId: string
  name: string
  createdAt: Date
}

interface RunRow {
  id: string
  jobId: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  findings: unknown
}

function posting(overrides: Partial<Posting> = {}): Posting {
  return {
    title: "Backend Engineer",
    company: "Acme",
    location: "Sydney",
    url: "https://www.seek.com.au/job/1",
    summary: "Building services.",
    matchReason: "Matches your titles.",
    ...overrides,
  }
}

/**
 * A stand-in for `prisma.job.findMany` that honours the parts of the query the
 * module depends on — the `userId` filter, the nested `status` filter, the
 * ordering and `take: 1`.
 *
 * Deliberately a real filter rather than a stub returning canned rows: the
 * claim under test is that a second user's Postings are unreachable, and a fake
 * that returned whatever it was seeded with would assert nothing about it. The
 * fake also records the `where` it was handed, so a test can check the filter
 * reached the database rather than only that this implementation applied it.
 */
class FakeDb {
  readonly jobs: JobRow[] = []
  readonly runs: RunRow[] = []
  readonly queries: unknown[] = []

  job(row: Partial<JobRow> & { id: string; userId: string }): this {
    this.jobs.push({
      name: `Briefing ${this.jobs.length + 1}`,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      ...row,
    })
    return this
  }

  run(row: Partial<RunRow> & { id: string; jobId: string }): this {
    this.runs.push({
      status: "succeeded",
      startedAt: new Date("2026-08-02T09:00:00.000Z"),
      finishedAt: new Date("2026-08-02T09:01:00.000Z"),
      findings: null,
      ...row,
    })
    return this
  }

  asPrisma(): PrismaClient {
    return {
      job: {
        findMany: async (query: {
          where: { userId: string }
          select: { runs: { where: { status: string } } }
        }) => {
          this.queries.push(query)

          const status = query.select.runs.where.status

          return this.jobs
            .filter((row) => row.userId === query.where.userId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((row) => ({
              id: row.id,
              name: row.name,
              runs: this.runs
                .filter((run) => run.jobId === row.id && run.status === status)
                .sort(
                  (a, b) =>
                    b.startedAt.getTime() - a.startedAt.getTime() ||
                    (a.id < b.id ? 1 : -1)
                )
                .slice(0, 1),
            }))
        },
      },
    } as unknown as PrismaClient
  }
}

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
})

describe("latestPostingsForUser", () => {
  it("renders the postings from the most recent succeeded run", async () => {
    db.job({ id: "job-1", userId: USER_ID, name: "Daily briefing" })
      .run({
        id: "run-old",
        jobId: "job-1",
        startedAt: new Date("2026-08-01T09:00:00.000Z"),
        findings: { postings: [posting({ title: "Yesterday's role" })] },
      })
      .run({
        id: "run-new",
        jobId: "job-1",
        startedAt: new Date("2026-08-02T09:00:00.000Z"),
        finishedAt: new Date("2026-08-02T09:04:00.000Z"),
        findings: {
          postings: [
            posting({ title: "Platform Engineer" }),
            posting({
              title: "Staff Engineer",
              url: "https://www.seek.com.au/job/2",
            }),
          ],
          notes: "One source returned nothing.",
        },
      })

    const [briefing, ...rest] = await latestPostingsForUser(
      db.asPrisma(),
      USER_ID
    )

    expect(rest).toEqual([])
    expect(briefing?.briefingName).toBe("Daily briefing")
    expect(briefing?.latest).toMatchObject({
      state: "recorded",
      notes: "One source returned nothing.",
    })

    const latest = briefing?.latest
    if (latest?.state !== "recorded") throw new Error("expected findings")

    expect(latest.postings.map((entry) => entry.title)).toEqual([
      "Platform Engineer",
      "Staff Engineer",
    ])
    // `finished_at`, formatted in a fixed locale and an explicit zone.
    expect(latest.ranAt).toContain("2 Aug 2026")
    expect(latest.ranAt).toContain("UTC")
  })

  /**
   * The security criterion, and the one the page guard cannot cover: the guard
   * says who is asking, not which rows they may read.
   */
  it("never returns another user's postings", async () => {
    db.job({ id: "mine", userId: USER_ID, name: "Mine" })
      .job({ id: "theirs", userId: OTHER_USER_ID, name: "Theirs" })
      .run({
        id: "run-mine",
        jobId: "mine",
        findings: { postings: [posting({ title: "My role" })] },
      })
      .run({
        id: "run-theirs",
        jobId: "theirs",
        findings: {
          postings: [
            posting({
              title: "Their role",
              url: "https://www.seek.com.au/job/secret",
            }),
          ],
        },
      })

    const briefings = await latestPostingsForUser(db.asPrisma(), USER_ID)

    expect(briefings.map((entry) => entry.briefingName)).toEqual(["Mine"])
    expect(JSON.stringify(briefings)).not.toContain("Their role")
    expect(JSON.stringify(briefings)).not.toContain("job/secret")
    // Not merely "this implementation filtered": the filter was in the query.
    expect(db.queries).toEqual([
      expect.objectContaining({ where: { userId: USER_ID } }),
    ])
  })

  it("asks the database only for succeeded runs", async () => {
    db.job({ id: "job-1", userId: USER_ID })
      .run({
        id: "run-failed",
        jobId: "job-1",
        status: "failed",
        startedAt: new Date("2026-08-03T09:00:00.000Z"),
        findings: { postings: [posting({ title: "From a failed run" })] },
      })
      .run({
        id: "run-ok",
        jobId: "job-1",
        startedAt: new Date("2026-08-02T09:00:00.000Z"),
        findings: { postings: [posting({ title: "From a good run" })] },
      })

    const [briefing] = await latestPostingsForUser(db.asPrisma(), USER_ID)
    const latest = briefing?.latest

    if (latest?.state !== "recorded") throw new Error("expected findings")
    expect(latest.postings.map((entry) => entry.title)).toEqual([
      "From a good run",
    ])
  })

  it("gives a briefing with no succeeded run an empty state", async () => {
    db.job({ id: "job-1", userId: USER_ID })

    const [briefing] = await latestPostingsForUser(db.asPrisma(), USER_ID)

    expect(briefing?.latest).toEqual({ state: "no-run" })
  })

  /** An empty findings list is a legitimate result, not an error. */
  it("treats a run that found nothing as an empty state", async () => {
    db.job({ id: "job-1", userId: USER_ID }).run({
      id: "run-1",
      jobId: "job-1",
      findings: { postings: [] },
    })

    const [briefing] = await latestPostingsForUser(db.asPrisma(), USER_ID)

    expect(briefing?.latest).toMatchObject({ state: "recorded", postings: [] })
  })

  /** Every run from before the `runs.findings` column existed looks like this. */
  it("treats a run that kept no findings as an empty state", async () => {
    db.job({ id: "job-1", userId: USER_ID }).run({
      id: "run-1",
      jobId: "job-1",
      findings: null,
    })

    const [briefing] = await latestPostingsForUser(db.asPrisma(), USER_ID)

    expect(briefing?.latest).toMatchObject({ state: "not-recorded" })
  })

  it("reports findings that do not match the schema as unreadable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    db.job({ id: "job-1", userId: USER_ID }).run({
      id: "run-1",
      jobId: "job-1",
      // A URL the schema rejects — the one field that must have been copied.
      findings: { postings: [{ ...posting(), url: "not a url" }] },
    })

    const [briefing] = await latestPostingsForUser(db.asPrisma(), USER_ID)

    expect(briefing?.latest).toMatchObject({ state: "unreadable" })
    expect(logged).toHaveBeenCalled()

    logged.mockRestore()
  })

  it("gives every posting a stable id derived from its url", async () => {
    db.job({ id: "job-1", userId: USER_ID }).run({
      id: "run-1",
      jobId: "job-1",
      findings: {
        postings: [
          posting({ url: "https://www.seek.com.au/job/1?ref=search" }),
          posting({ url: "https://www.seek.com.au/job/2" }),
        ],
      },
    })

    const [briefing] = await latestPostingsForUser(db.asPrisma(), USER_ID)
    const latest = briefing?.latest

    if (latest?.state !== "recorded") throw new Error("expected findings")

    const ids = latest.postings.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true)
    // Tracking parameters are not part of the identity, so the same
    // advertisement reached through a different search keeps the same id — and
    // the same React key across runs.
    expect(ids[0]).toBe(postingId({ url: "https://www.seek.com.au/job/1" }))
  })

  it("returns nothing for a user with no briefings", async () => {
    db.job({ id: "theirs", userId: OTHER_USER_ID })

    expect(await latestPostingsForUser(db.asPrisma(), USER_ID)).toEqual([])
  })
})
