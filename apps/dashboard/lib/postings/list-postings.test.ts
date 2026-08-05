import type { PrismaClient } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { listPostings } from "./list-postings"
import { PAGE_SIZE, parsePostingQuery } from "./posting-query"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"

/** A row as the table's query selects it back out. */
interface PostingRow {
  userId: string
  postingId: string
  title: string
  company: string
  location: string
  url: string
  status: string
  payload: unknown
  firstSeenAt: Date
  lastSeenAt: Date
}

function payload(overrides: Record<string, unknown> = {}) {
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
 * A stand-in for `prisma.posting` that honours the parts of the query this
 * module depends on — the `userId` filter, the ordering, `skip` and `take`.
 *
 * Deliberately a real filter rather than a stub returning canned rows: the
 * claim under test is that a second user's Postings are unreachable, and a fake
 * that returned whatever it was seeded with would assert nothing about it. It
 * also records every query it was handed, so a test can check the filter and
 * the tie-break reached the database rather than only that this implementation
 * applied them.
 */
class FakeDb {
  readonly rows: PostingRow[] = []
  readonly counts: unknown[] = []
  readonly queries: unknown[] = []

  posting(row: Partial<PostingRow> & { postingId: string }): this {
    const at = new Date(
      Date.parse("2026-08-01T00:00:00.000Z") + this.rows.length * 3_600_000
    )

    this.rows.push({
      userId: USER_ID,
      title: `Role ${this.rows.length + 1}`,
      company: "Acme",
      location: "Sydney",
      url: `https://www.seek.com.au/job/${this.rows.length + 1}`,
      status: "new",
      payload: payload(),
      firstSeenAt: at,
      lastSeenAt: at,
      ...row,
    })

    return this
  }

  many(count: number): this {
    for (let index = 0; index < count; index++) {
      this.posting({ postingId: `${index}`.padStart(16, "0") })
    }

    return this
  }

  asPrisma(): PrismaClient {
    return {
      posting: {
        count: async (query: { where: { userId: string } }) => {
          this.counts.push(query)
          return this.mine(query.where.userId).length
        },
        findMany: async (query: {
          where: { userId: string }
          orderBy: Record<string, "asc" | "desc">[]
          skip: number
          take: number
        }) => {
          this.queries.push(query)

          const ordered = [...this.mine(query.where.userId)].sort(
            (left, right) => {
              for (const clause of query.orderBy) {
                for (const [field, direction] of Object.entries(clause)) {
                  const a = left[field as keyof PostingRow]
                  const b = right[field as keyof PostingRow]
                  const compared =
                    a instanceof Date && b instanceof Date
                      ? a.getTime() - b.getTime()
                      : String(a).localeCompare(String(b))

                  if (compared !== 0) {
                    return direction === "desc" ? -compared : compared
                  }
                }
              }

              return 0
            }
          )

          return ordered.slice(query.skip, query.skip + query.take)
        },
      },
    } as unknown as PrismaClient
  }

  private mine(userId: string): PostingRow[] {
    return this.rows.filter((row) => row.userId === userId)
  }
}

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
})

describe("listPostings", () => {
  it("returns one page of this user's postings", async () => {
    db.posting({ postingId: "a".repeat(16), title: "Platform Engineer" })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page).toMatchObject({ total: 1, page: 1, pageCount: 1 })
    expect(page.postings.map((row) => row.title)).toEqual(["Platform Engineer"])
    expect(page.postings[0]?.summary).toBe("Building services.")
  })

  /**
   * The security criterion, and the one the page guard cannot cover: the guard
   * says who is asking, not which rows they may read.
   */
  it("never returns another user's postings", async () => {
    db.posting({ postingId: "a".repeat(16), title: "Mine" }).posting({
      postingId: "b".repeat(16),
      title: "Theirs",
      userId: OTHER_USER_ID,
      url: "https://www.seek.com.au/job/secret",
    })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page.postings.map((row) => row.title)).toEqual(["Mine"])
    expect(JSON.stringify(page)).not.toContain("Theirs")
    expect(JSON.stringify(page)).not.toContain("job/secret")

    // Not merely "this implementation filtered": the filter was in both queries.
    expect(db.counts).toEqual([{ where: { userId: USER_ID } }])
    expect(db.queries).toEqual([
      expect.objectContaining({ where: { userId: USER_ID } }),
    ])
  })

  it("skips and takes a whole page at a time", async () => {
    db.many(PAGE_SIZE * 2 + 3)

    const first = await listPostings(
      db.asPrisma(),
      USER_ID,
      parsePostingQuery()
    )
    expect(first).toMatchObject({ page: 1, pageCount: 3 })
    expect(first.postings).toHaveLength(PAGE_SIZE)
    expect(db.queries.at(-1)).toMatchObject({ skip: 0, take: PAGE_SIZE })

    const second = await listPostings(
      db.asPrisma(),
      USER_ID,
      parsePostingQuery({ page: "2" })
    )
    expect(second.page).toBe(2)
    expect(db.queries.at(-1)).toMatchObject({
      skip: PAGE_SIZE,
      take: PAGE_SIZE,
    })

    // No row on two pages and none skipped between them.
    const ids = [...first.postings, ...second.postings].map((row) => row.id)
    expect(new Set(ids).size).toBe(PAGE_SIZE * 2)
  })

  /**
   * ⚠️ A page past the end renders the last page, not an empty one with
   * working controls underneath it — which is why the count runs first and the
   * clamp happens before anything is fetched.
   */
  it("clamps a page past the end to the last one", async () => {
    db.many(PAGE_SIZE + 1)

    const page = await listPostings(
      db.asPrisma(),
      USER_ID,
      parsePostingQuery({ page: "99" })
    )

    expect(page).toMatchObject({ page: 2, pageCount: 2 })
    expect(page.postings).toHaveLength(1)
    expect(db.queries.at(-1)).toMatchObject({ skip: PAGE_SIZE })
  })

  /**
   * ⚠️ Offset pagination over a non-unique sort key shows one row twice and
   * skips another. Every order carries the tie-break, in the same direction.
   */
  it("tie-breaks every order on the posting id", async () => {
    db.many(1)

    for (const sort of [
      "lastSeen",
      "firstSeen",
      "title",
      "company",
      "status",
    ]) {
      await listPostings(
        db.asPrisma(),
        USER_ID,
        parsePostingQuery({ sort, dir: "asc" })
      )

      expect(db.queries.at(-1)).toMatchObject({
        orderBy: [expect.anything(), { postingId: "asc" }],
      })
    }
  })

  it("orders on the column the query names", async () => {
    db.posting({ postingId: "a".repeat(16), title: "Zebra Wrangler" }).posting({
      postingId: "b".repeat(16),
      title: "Alpaca Herder",
    })

    const page = await listPostings(
      db.asPrisma(),
      USER_ID,
      parsePostingQuery({ sort: "title" })
    )

    expect(page.postings.map((row) => row.title)).toEqual([
      "Alpaca Herder",
      "Zebra Wrangler",
    ])
  })

  /**
   * The projected columns are written by the same statement as the payload, so
   * a payload the schema no longer matches costs the detail and not the row.
   */
  it("degrades an unreadable payload rather than dropping the row", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    db.posting({
      postingId: "a".repeat(16),
      title: "Still here",
      // A URL the schema rejects — the one field that must have been copied.
      payload: payload({ url: "not a url" }),
    })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page.postings).toHaveLength(1)
    expect(page.postings[0]).toMatchObject({
      title: "Still here",
      highlights: [],
    })
    expect(page.postings[0]?.summary).toBeUndefined()
    expect(logged).toHaveBeenCalled()

    logged.mockRestore()
  })

  it("issues no second query when there is nothing to page", async () => {
    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page).toEqual({
      postings: [],
      total: 0,
      page: 1,
      pageCount: 1,
      pageSize: PAGE_SIZE,
    })
    expect(db.counts).toHaveLength(1)
    expect(db.queries).toEqual([])
  })
})
