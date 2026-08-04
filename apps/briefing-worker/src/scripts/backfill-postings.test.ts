import { postingId } from "@workspace/agents"
import type { PrismaClient, SeenPostings } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { backfillPostings } from "./backfill-postings.ts"

/**
 * The walk, driven over a fake `run.findMany` and a fake write.
 *
 * Everything asserted here is a property of the *walk*: the order it reads in,
 * the instant it attributes a sighting to, and what it does with a Run whose
 * findings it cannot use. The upsert's own properties — a status surviving a
 * second sighting, an older sighting not moving `last_seen_at` backwards — are
 * properties of Postgres and are tested in `packages/db/src/stores.test.ts`,
 * which needs a real database.
 */

const USER = "33333333-3333-4333-8333-333333333333"
const URL = "https://www.seek.com.au/job/93431609"

function findings(url = URL) {
  return {
    postings: [
      {
        title: "Senior Backend Engineer",
        company: "Acme",
        location: "Sydney NSW",
        url,
        summary: "A backend role on a real-time data product.",
        matchReason: "Backend, Sydney, Python and AWS.",
      },
    ],
  }
}

function run(overrides: {
  id: string
  startedAt: Date
  findings: unknown
  userId?: string
}) {
  return {
    id: overrides.id,
    startedAt: overrides.startedAt,
    findings: overrides.findings,
    job: { userId: overrides.userId ?? USER },
  }
}

const findMany = vi.fn()
const record = vi.fn<(seen: SeenPostings) => Promise<number>>()

const prisma = { run: { findMany } } as unknown as PrismaClient

/** One page, then the end of the walk. */
function returns(...pages: unknown[][]) {
  for (const page of pages) findMany.mockResolvedValueOnce(page)
  findMany.mockResolvedValue([])
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  findMany.mockReset()
  record.mockReset()
  record.mockResolvedValue(1)
})

describe("backfillPostings", () => {
  it("walks succeeded runs oldest first, tie-broken so no run is read twice", async () => {
    returns([])

    await backfillPostings(prisma, record)

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "succeeded" },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      })
    )
  })

  it("does not put the findings column in the query at all", async () => {
    returns([])

    await backfillPostings(prisma, record)

    // `{ findings: { not: null } }` over a nullable JSONB column is the
    // Prisma DbNull/JsonNull trap: a filter that silently matches nothing,
    // which in a backfill is indistinguishable from a clean run. The skip
    // happens in TypeScript, so the predicate must stay this narrow.
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>
    expect(Object.keys(where)).toEqual(["status"])
  })

  it("attributes each sighting to the run's own started_at", async () => {
    const startedAt = new Date("2026-07-28T23:30:00.000Z")
    returns([run({ id: "run-1", startedAt, findings: findings() })])

    await backfillPostings(prisma, record)

    // Not the wall clock. This is the whole point of the script: it is what
    // makes `first_seen_at` mean "when this advertisement first appeared".
    expect(record).toHaveBeenCalledWith({
      userId: USER,
      runId: "run-1",
      seenAt: startedAt,
      postings: [
        expect.objectContaining({
          postingId: postingId({ url: URL }),
          url: URL,
        }),
      ],
    })
  })

  it("derives ids with the worker's own function, never a second rule", async () => {
    returns([
      run({
        id: "run-1",
        startedAt: new Date("2026-07-01T00:00:00.000Z"),
        // SEEK stamps the search that surfaced a listing onto its URL, so the
        // backfill and a later live run only agree if both normalise. Equality
        // with `postingId()` rather than a literal digest: what must not drift
        // is the rule, and a literal would keep passing after a reimplementation
        // started disagreeing with it.
        findings: findings(`${URL}?ref=search-standalone`),
      }),
    ])

    await backfillPostings(prisma, record)

    const seen = record.mock.calls[0]?.[0]
    expect(seen?.postings[0]?.postingId).toBe(postingId({ url: URL }))
  })

  it("skips a run whose findings are absent, and counts it", async () => {
    returns([
      run({
        id: "run-1",
        startedAt: new Date("2026-07-01T00:00:00.000Z"),
        findings: null,
      }),
    ])

    const report = await backfillPostings(prisma, record)

    // A run from before the column existed is an ordinary state, not a fault.
    expect(record).not.toHaveBeenCalled()
    expect(report).toMatchObject({
      runsWalked: 1,
      runsSkipped: 1,
      recordsWritten: 0,
    })
  })

  it("skips a run whose findings do not parse, without stopping the walk", async () => {
    returns([
      run({
        id: "run-1",
        startedAt: new Date("2026-07-01T00:00:00.000Z"),
        findings: { postings: [{ title: "Missing everything else" }] },
      }),
      run({
        id: "run-2",
        startedAt: new Date("2026-07-02T00:00:00.000Z"),
        findings: findings(),
      }),
    ])

    const report = await backfillPostings(prisma, record)

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]?.[0]?.runId).toBe("run-2")
    expect(report).toMatchObject({ runsWalked: 2, runsSkipped: 1 })
  })

  it("reports what it did in one structured line", async () => {
    record.mockResolvedValueOnce(3).mockResolvedValueOnce(2)
    returns([
      run({
        id: "run-1",
        startedAt: new Date("2026-07-01T00:00:00.000Z"),
        findings: findings(),
      }),
      run({
        id: "run-2",
        startedAt: new Date("2026-07-02T00:00:00.000Z"),
        findings: findings("https://example.com/jobs/2"),
      }),
      run({
        id: "run-3",
        startedAt: new Date("2026-07-03T00:00:00.000Z"),
        findings: null,
      }),
    ])

    const report = await backfillPostings(prisma, record)

    expect(report).toMatchObject({
      event: "backfill-postings",
      runsWalked: 3,
      runsSkipped: 1,
      recordsWritten: 5,
    })
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0])).toMatchObject(
      {
        event: "backfill-postings",
        runsWalked: 3,
        runsSkipped: 1,
        recordsWritten: 5,
      }
    )
  })

  it("pages with a cursor rather than holding every run at once", async () => {
    const full = Array.from({ length: 100 }, (_, index) =>
      run({
        id: `run-${index}`,
        startedAt: new Date(Date.UTC(2026, 6, 1, index)),
        findings: findings(`https://example.com/jobs/${index}`),
      })
    )
    returns(full, [
      run({
        id: "run-100",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        findings: findings("https://example.com/jobs/100"),
      }),
    ])

    const report = await backfillPostings(prisma, record)

    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty("cursor")
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      cursor: { id: "run-99" },
      skip: 1,
    })
    expect(report.runsWalked).toBe(101)
  })
})
