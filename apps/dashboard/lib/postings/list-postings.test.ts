import type { PrismaClient } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { formatSeenAgo, listPostings } from "./list-postings"
import { PAGE_SIZE, parsePostingQuery, POSTING_SORTS } from "./posting-query"

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
  /** NULL when the advertisement stated no date, or stated a non-date. */
  postedAt: Date | null
  payload: unknown
  firstSeenAt: Date
  lastSeenAt: Date
  /**
   * The Briefing that most recently found it, as the nested `select` asks for
   * it. `null` is the case a real database cannot produce — both foreign keys
   * are NOT NULL — and that this module must survive anyway, because a client
   * that ignores `select` produces it too.
   */
  lastSeenRun: { job: { name: string } | null } | null
}

/** The Briefing every row here was found by unless a test says otherwise. */
const DEFAULT_BRIEFING = "Sydney backend roles"

/**
 * One `orderBy` clause, in either spelling Prisma uses.
 *
 * `{ field: "desc" }` for a column that cannot be null, and
 * `{ field: { sort, nulls } }` for one that can — `postedAt` is the only such
 * column here. A fake that read the second as a direction string would sort
 * ascending silently, which is why this is typed rather than left as
 * `Record<string, string>`.
 */
type OrderByClause = Record<
  string,
  "asc" | "desc" | { sort: "asc" | "desc"; nulls?: "first" | "last" }
>

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
 *
 * `select` is not applied — the rows are seeded with the relation already on
 * them, which is what a database honouring the projection would answer. That
 * the projection was *asked for* is asserted against the recorded query
 * instead, since a fake answering more than it was asked cannot otherwise tell
 * a `select` that stopped naming the relation from one that still does.
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
      postedAt: null,
      payload: payload(),
      firstSeenAt: at,
      lastSeenAt: at,
      lastSeenRun: { job: { name: DEFAULT_BRIEFING } },
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
          orderBy: OrderByClause[]
          skip: number
          take: number
          select: Record<string, unknown>
        }) => {
          this.queries.push(query)

          const ordered = [...this.mine(query.where.userId)].sort(
            (left, right) => {
              for (const clause of query.orderBy) {
                for (const [field, spec] of Object.entries(clause)) {
                  const direction = typeof spec === "string" ? spec : spec.sort
                  const nulls =
                    typeof spec === "string" ? undefined : spec.nulls

                  const a = left[field as keyof PostingRow]
                  const b = right[field as keyof PostingRow]

                  // Nullity is decided before the direction is applied, as
                  // Postgres decides it: `nulls: "last"` means last whichever
                  // way the values run. Flipping it with the direction is
                  // exactly the bug the tests below would then fail to catch.
                  if (a === null || b === null) {
                    if (a === null && b === null) continue

                    const last =
                      nulls === undefined
                        ? direction === "asc"
                        : nulls === "last"

                    return (a === null ? 1 : -1) * (last ? 1 : -1)
                  }

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

    // Driven from the list itself rather than written out again: a sort added
    // to `POSTING_SORTS` without a tie-break is exactly what this asserts
    // against, and a hand-copied list here would simply not cover it.
    for (const sort of POSTING_SORTS) {
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
   * The Posted column is the only nullable thing this table orders by, and NULL
   * there does not mean "long ago" — it means the advertisement did not state a
   * date, or stated something the write path would not read as one.
   *
   * ⚠️ **Both directions are asserted, and that is the whole test.** Postgres
   * defaults to NULLS FIRST under `DESC`, so a clause that merely said
   * `{ postedAt: "desc" }` would put every undated row above every dated one —
   * passing an ascending-only test and being visibly wrong on the first click.
   */
  describe("ordering on the posting date", () => {
    function seedDatedAndUndated() {
      db.posting({
        postingId: "a".repeat(16),
        title: "Older",
        postedAt: new Date("2026-07-01T00:00:00.000Z"),
      })
        .posting({
          postingId: "b".repeat(16),
          title: "Newer",
          postedAt: new Date("2026-08-01T00:00:00.000Z"),
        })
        .posting({ postingId: "c".repeat(16), title: "Undated" })
    }

    it("puts the newest first and the undated last", async () => {
      seedDatedAndUndated()

      const page = await listPostings(
        db.asPrisma(),
        USER_ID,
        parsePostingQuery({ sort: "posted" })
      )

      expect(page.postings.map((row) => row.title)).toEqual([
        "Newer",
        "Older",
        "Undated",
      ])
    })

    it("keeps the undated last when the order is reversed", async () => {
      seedDatedAndUndated()

      const page = await listPostings(
        db.asPrisma(),
        USER_ID,
        parsePostingQuery({ sort: "posted", dir: "asc" })
      )

      expect(page.postings.map((row) => row.title)).toEqual([
        "Older",
        "Newer",
        "Undated",
      ])
    })

    it("asks the database for nulls last rather than doing it afterwards", async () => {
      db.many(1)

      await listPostings(
        db.asPrisma(),
        USER_ID,
        parsePostingQuery({ sort: "posted" })
      )

      // Paging is offset-based, so a rule applied to the page in memory would
      // only order the twenty-five rows that already came back.
      expect(db.queries.at(-1)).toMatchObject({
        orderBy: [
          { postedAt: { sort: "desc", nulls: "last" } },
          { postingId: "desc" },
        ],
      })
    })
  })

  describe("the Posted cell", () => {
    it("formats the column when the write path read a date", async () => {
      db.posting({
        postingId: "a".repeat(16),
        postedAt: new Date("2026-07-30T00:00:00.000Z"),
        payload: payload({ postedAt: "2026-07-30" }),
      })

      const [row] = (
        await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())
      ).postings

      // `en-AU` spells the month out even under `month: "short"`, exactly as
      // `formatSeenAt` already renders a sighting — the two agree because they
      // pin the same locale and the same zone.
      expect(row?.postedAt).toBe("30 July 2026")
    })

    /**
     * The fallback, and it is deliberate: an advertisement that said "3 days
     * ago" keeps saying it rather than degrading to an em-dash. The row sorts
     * last either way, and a phrase is visibly not a date, so what is on screen
     * cannot appear to contradict the order it sits in.
     */
    it("keeps the advertisement's own words when it did not", async () => {
      db.posting({
        postingId: "a".repeat(16),
        postedAt: null,
        payload: payload({ postedAt: "3 days ago" }),
      })

      const [row] = (
        await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())
      ).postings

      expect(row?.postedAt).toBe("3 days ago")
    })

    it("says nothing when the advertisement said nothing", async () => {
      db.posting({ postingId: "a".repeat(16), postedAt: null })

      const [row] = (
        await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())
      ).postings

      expect(row?.postedAt).toBeUndefined()
    })
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

  /**
   * The field the detail dialog needs and a row has no width for: this page is
   * cumulative across every Briefing a user has, so the row alone does not say
   * which one surfaced the advertisement.
   */
  it("names the briefing that last found a posting", async () => {
    db.posting({
      postingId: "a".repeat(16),
      lastSeenRun: { job: { name: "Melbourne staff roles" } },
    })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page.postings[0]?.briefing).toBe("Melbourne staff roles")

    // Not merely "this implementation produced a name": the relation was asked
    // for, and it was `lastSeenRun` rather than `firstSeenRun`. A fake seeded
    // with the relation already on its rows cannot tell the difference.
    expect(db.queries.at(-1)).toMatchObject({
      select: { lastSeenRun: { select: { job: { select: { name: true } } } } },
    })
  })

  /**
   * The same judgement as the unreadable payload above: which Briefing found an
   * advertisement is provenance, and the advertisement is what the user came
   * for. Neither foreign key is nullable, so a hole here is what a client
   * answering less than it was asked looks like — the `DEV_AUTH_BYPASS` fake,
   * until it learned to apply `select`.
   */
  it("degrades a briefing it cannot name rather than dropping the row", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    db.posting({
      postingId: "a".repeat(16),
      title: "Still here",
      lastSeenRun: null,
    }).posting({
      postingId: "b".repeat(16),
      title: "Also here",
      lastSeenRun: { job: null },
    })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page.postings.map((row) => row.title)).toEqual([
      "Also here",
      "Still here",
    ])
    expect(page.postings.map((row) => row.briefing)).toEqual([
      "Unknown briefing",
      "Unknown briefing",
    ])
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

/**
 * The sighting times as the detail panel renders them.
 *
 * Testable at all only because `now` is a parameter: a formatter that read the
 * clock could only be asserted against relative to the moment the suite
 * happened to run, which is the same expression under test.
 */
describe("formatSeenAgo", () => {
  const NOW = new Date("2026-08-06T12:00:00.000Z")

  function ago(milliseconds: number): string {
    return formatSeenAgo(new Date(NOW.getTime() - milliseconds), NOW)
  }

  const SECOND = 1000
  const MINUTE = 60 * SECOND
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  it("picks the largest unit that fits the gap", () => {
    expect(ago(45 * SECOND)).toBe("45 seconds ago")
    expect(ago(5 * MINUTE)).toBe("5 minutes ago")
    expect(ago(3 * HOUR)).toBe("3 hours ago")
    expect(ago(3 * DAY)).toBe("3 days ago")
    expect(ago(3 * 7 * DAY)).toBe("3 weeks ago")
    expect(ago(90 * DAY)).toBe("3 months ago")
    expect(ago(2 * 365 * DAY)).toBe("2 years ago")
  })

  /**
   * The reason for `numeric: "auto"`, and the whole point of using
   * `Intl.RelativeTimeFormat` rather than assembling the string by hand: a
   * posting re-found this morning should not read "0 days ago".
   */
  it("says yesterday and today rather than counting", () => {
    expect(ago(0)).toBe("now")
    expect(ago(30 * SECOND)).toBe("30 seconds ago")
    expect(ago(DAY)).toBe("yesterday")
  })

  /**
   * Both columns are written by a Run that has already finished, so this should
   * not arise — but the worker and the web host are different machines, and a
   * future sighting rendered as "just now" would hide a clock skew rather than
   * show it.
   */
  it("does not clamp a future sighting", () => {
    expect(formatSeenAgo(new Date(NOW.getTime() + 3 * DAY), NOW)).toBe(
      "in 3 days"
    )
  })
})
