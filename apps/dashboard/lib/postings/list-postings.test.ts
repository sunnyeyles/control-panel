import type { PrismaClient } from "@workspace/db"
import { normalizeTitle } from "@workspace/job-search"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { matchesPostingWhere, type PostingWhere } from "@/lib/dev/fake-prisma"

import { formatSeenAgo, listPostings } from "./list-postings"
import { PAGE_SIZE, parsePostingQuery } from "./posting-query"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"

/** A row as the table's query selects it back out. */
interface PostingRow {
  userId: string
  postingId: string
  title: string
  /**
   * `title` as `0010`'s generated column derives it, which is what the title
   * filter is matched against. Seeded rather than stated, for the reason the
   * dev fixtures give: Postgres computes it and no row can carry a value that
   * disagrees with its own title.
   */
  titleNormalized: string
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
 * A stand-in for `prisma.posting` that records every query it is handed and
 * answers with its seeded rows, filtered by the `where`'s `userId`.
 *
 * That one filter is real rather than canned because the claim under test is
 * that a second user's Postings are unreachable, and a fake that returned
 * whatever it was seeded with would assert nothing about it.
 *
 * **Ordering, `skip` and `take` are deliberately not applied.** `listPostings`
 * delegates the page read to `listPostingPage` in `@workspace/db`, and the
 * ordering and paging behaviour — NULLS LAST in both directions, the
 * `postingId` tie-break, the clamp against the real page count — is proven
 * against a real Postgres in `packages/db/src/stores.test.ts`. This suite used
 * to re-sort with JavaScript written to match what Postgres was believed to
 * do, which checked the belief rather than the database. Rows come back in the
 * order they were seeded.
 *
 * `select` is not applied either — the rows are seeded with the relation
 * already on them, which is what a database honouring the projection would
 * answer. That the projection was *asked for* is asserted against the recorded
 * query instead, since a fake answering more than it was asked cannot
 * otherwise tell a `select` that stopped naming the relation from one that
 * still does.
 */
class FakeDb {
  readonly rows: PostingRow[] = []
  readonly counts: unknown[] = []
  readonly queries: unknown[] = []
  /** The account's title filter, as `posting_filters` holds it. */
  private exclusions: string[] | undefined

  posting(row: Partial<PostingRow> & { postingId: string }): this {
    const at = new Date(
      Date.parse("2026-08-01T00:00:00.000Z") + this.rows.length * 3_600_000
    )
    const seeded = {
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
    }

    this.rows.push({
      // Derived from whatever title won, so a row seeded with an overridden
      // title cannot end up normalised from the default one.
      titleNormalized: normalizeTitle(seeded.title),
      ...seeded,
    })

    return this
  }

  /** Give this user a saved filter. No call means they have never saved one. */
  filtering(...terms: string[]): this {
    this.exclusions = terms
    return this
  }

  asPrisma(): PrismaClient {
    return {
      posting: {
        count: async (query: { where: PostingWhere }) => {
          this.counts.push(query)
          return this.matching(query.where).length
        },
        findMany: async (query: { where: PostingWhere }) => {
          this.queries.push(query)
          return this.matching(query.where)
        },
      },
      postingFilters: {
        findUnique: async (query: { where: { userId: string } }) =>
          this.exclusions === undefined || query.where.userId !== USER_ID
            ? null
            : { userId: USER_ID, titleExclusions: this.exclusions },
      },
    } as unknown as PrismaClient
  }

  /**
   * ⚠️ **`matchesPostingWhere` rather than a `userId` comparison written here.**
   * The `where` now carries the exclusion as well as the owner, and a second
   * spelling of "which rows does this name" is one more than the number that
   * can be wrong without anyone noticing — the same argument `fake-prisma.ts`
   * makes for exporting the predicate in the first place.
   */
  private matching(where: PostingWhere): PostingRow[] {
    return this.rows.filter((row) => matchesPostingWhere(row, where))
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
  })

  /**
   * ⚠️ **The payload's prose must not reach the table**, which is the whole
   * point of `load-posting-detail.ts`. `summary`, `matchReason` and
   * `highlights` are the largest fields a Posting has and at most one row is
   * expanded, so carrying them here put a page of unread prose into the RSC
   * payload of every sort click. Asserted by key rather than by value, so a
   * field creeping back on fails here rather than in a bundle-size review.
   */
  it("carries none of the expanded row's prose", async () => {
    db.posting({ postingId: "a".repeat(16), title: "Platform Engineer" })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(Object.keys(page.postings[0] ?? {})).not.toContain("summary")
    expect(Object.keys(page.postings[0] ?? {})).not.toContain("matchReason")
    expect(Object.keys(page.postings[0] ?? {})).not.toContain("highlights")
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

  // How a page is ordered, paged, tie-broken and clamped is `listPostingPage`'s
  // contract, exercised against a real Postgres in
  // `packages/db/src/stores.test.ts` — see the preamble of its "reading a page"
  // block for why those assertions could not honestly live here.

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
      // The board is read off the `url` column, which the same statement wrote
      // — so an unreadable payload costs the detail and not the badge.
      source: { label: "SEEK", recognised: true },
    })

    // ⚠️ **The report still fires, and it no longer has a `summary` to infer
    // it from.** The count used to be "how many views came back without a
    // summary", which stopped being answerable when that field moved to
    // `load-posting-detail.ts`. If this stops being called, a page of drifted
    // payloads goes by in silence.
    expect(logged).toHaveBeenCalled()

    logged.mockRestore()
  })

  /**
   * The board is derived from `postings.url` rather than stored, so the answer
   * is whatever the column holds — which is why a row written long before this
   * field existed still carries one. `posting-source.test.ts` pins the
   * derivation itself; this pins that the page applies it.
   */
  it("carries the board each posting's url names", async () => {
    db.posting({
      postingId: "a".repeat(16),
      url: "https://au.linkedin.com/jobs/view/4123456789",
    })
    db.posting({
      postingId: "b".repeat(16),
      url: "https://boards.greenhouse.io/acme/jobs/7",
    })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    // Seeded order — the fake does not sort; the real order is the database's.
    expect(page.postings.map((posting) => posting.source)).toEqual([
      { label: "LinkedIn", recognised: true },
      { label: "boards.greenhouse.io", recognised: false },
    ])
  })

  /**
   * ⚠️ `postings.url` is `TEXT NOT NULL` with no CHECK, unlike `posting_id`, so
   * the column can hold a value that will not parse. The same judgement as the
   * unreadable payload above: the advertisement is what the user came for, and
   * losing its badge must not look like a Posting nobody ever found.
   */
  it("degrades a url it cannot read rather than dropping the row", async () => {
    db.posting({
      postingId: "a".repeat(16),
      title: "Still here",
      url: "not a url",
    })

    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page.postings).toHaveLength(1)
    expect(page.postings[0]).toMatchObject({ title: "Still here" })
    expect(page.postings[0]?.source).toBeUndefined()
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
      "Still here",
      "Also here",
    ])
    expect(page.postings.map((row) => row.briefing)).toEqual([
      "Unknown briefing",
      "Unknown briefing",
    ])
    expect(logged).toHaveBeenCalled()

    logged.mockRestore()
  })

  /**
   * An empty table still issues the speculative fetch, because it is sent
   * before anything has been counted. It costs no wall-clock — it runs
   * alongside the count — and it is the price of the common path being one
   * round trip rather than two. What must not change is the shape returned:
   * `pageCount` is 1 and not 0, so the pager renders "page 1 of 1" rather than
   * a page that does not exist.
   */
  it("returns a usable empty page rather than a zero-page one", async () => {
    const page = await listPostings(db.asPrisma(), USER_ID, parsePostingQuery())

    expect(page).toEqual({
      postings: [],
      total: 0,
      hidden: 0,
      page: 1,
      pageCount: 1,
      pageSize: PAGE_SIZE,
    })
    expect(db.counts).toHaveLength(1)
    expect(db.queries).toHaveLength(1)
  })

  /**
   * The account-wide title filter, as this module applies it.
   *
   * What is asserted here is the *translation*: that a saved word becomes a
   * normalised pattern before it reaches `@workspace/db`, and that the count
   * the page renders describes the rows it will actually show. Whether the SQL
   * then matches the right rows is proven against a real Postgres in
   * `packages/db/src/stores.test.ts` — a fake could only agree with whoever
   * wrote it.
   */
  describe("the title filter", () => {
    function seeded() {
      return db
        .posting({
          postingId: "a".repeat(16),
          title: "Senior Backend Engineer",
        })
        .posting({ postingId: "b".repeat(16), title: "Backend Engineer" })
        .posting({ postingId: "c".repeat(16), title: "HTML Developer" })
    }

    it("hides a matching row and says how many it hid", async () => {
      const page = await listPostings(
        seeded().filtering("senior").asPrisma(),
        USER_ID,
        parsePostingQuery()
      )

      expect(page.postings.map((row) => row.title)).toEqual([
        "Backend Engineer",
        "HTML Developer",
      ])
      // ⚠️ `total` is the filtered count, because it is what `pageCount` comes
      // from and what the table labels itself with; `hidden` is the separate
      // fact the page has to say out loud, or a filter and a dead briefing look
      // identical.
      expect(page.total).toBe(2)
      expect(page.hidden).toBe(1)
    })

    it("sends the database a pattern, not the word the user typed", async () => {
      await listPostings(
        seeded().filtering("Senior").asPrisma(),
        USER_ID,
        parsePostingQuery()
      )

      // Space-padded and lowercased here, because whole-word matching is what
      // the padding *is* — `@workspace/db` filters and does not interpret.
      expect(db.queries[0]).toMatchObject({
        where: {
          userId: USER_ID,
          NOT: { OR: [{ titleNormalized: { contains: " senior " } }] },
        },
      })
    })

    it("asks for the same rows in the count as in the page", async () => {
      await listPostings(
        seeded().filtering("senior").asPrisma(),
        USER_ID,
        parsePostingQuery()
      )

      // A filter applied to one and not the other is a pager that walks off the
      // end of its own table.
      expect(db.counts[0]).toMatchObject({
        where: { NOT: { OR: [{ titleNormalized: { contains: " senior " } }] } },
      })
    })

    it("filters nothing, and hides nothing, for a user who has saved none", async () => {
      const page = await listPostings(
        seeded().asPrisma(),
        USER_ID,
        parsePostingQuery()
      )

      expect(page.total).toBe(3)
      expect(page.hidden).toBe(0)
      // No `NOT` at all rather than an empty one, so an unfiltered account
      // issues exactly the query it always did.
      expect(db.queries[0]).not.toHaveProperty("where.NOT")
    })
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
