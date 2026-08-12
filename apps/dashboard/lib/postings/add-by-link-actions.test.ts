import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import type { ActionState } from "@/lib/actions/action-state"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  ANONYMOUS,
  REFUSED,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"
import type { Agent } from "@workspace/agents"
import type { PostingFetch } from "@workspace/agents/board-fetch"
import type { PageExtractResult } from "@workspace/agent-tools/page-extract"
import type { PrismaClient } from "@workspace/db"
import { describe, expect, it, vi } from "vitest"

import {
  ALREADY_TRACKED,
  createAddByLinkActions,
  READ_FAILED,
} from "./add-by-link-actions"

/**
 * Adding a Posting from a pasted link, and above all what it refuses.
 *
 * 1. **Nothing is spent until every refusal has passed.** A signed-out caller, a
 *    malformed link and an advertisement already tracked must each be answered
 *    before the page is fetched and before the extractor is *built* — building
 *    it is what commits to a model. `fetches` and `extractorBuilds` count those
 *    separately; an assertion on the prompt alone would pass for an
 *    implementation that fetched a page and then decided not to use it.
 * 2. **The stored URL is the one the user pasted.** The extractor is never shown
 *    a link and its schema has nowhere to return one, so the assertion is that a
 *    model going out of its way to supply one changes nothing.
 */

const NOW = new Date("2026-08-05T04:15:00.000Z")

const URL = "https://boards.greenhouse.io/holloway/jobs/4012345678"

const PAGE = [
  "# Backend Engineer",
  "",
  "Holloway Labs — Remote (Australia)",
  "",
  "Small platform team, mostly TypeScript and Postgres.",
].join("\n")

/** What a well-behaved extractor answers with: JSON and nothing else. */
const EXTRACTION = {
  kind: "posting",
  posting: {
    title: "Backend Engineer",
    company: "Holloway Labs",
    location: "Remote (Australia)",
    postedAt: "2026-08-04",
    summary: "Small platform team, mostly TypeScript and Postgres.",
  },
}

/**
 * A stand-in for the posting extractor.
 *
 * Cast to `Agent` rather than built with `createPostingExtractor`, which would
 * need a LangChain chat model this app does not depend on. That the real agent
 * holds no tools and what its prompt says is asserted in `packages/agents`;
 * what matters here is whether it is reached at all and what the action does
 * with what comes back.
 */
class FakeExtractor {
  readonly prompts: string[] = []
  reply: string = JSON.stringify(EXTRACTION)

  async invoke(input: {
    messages: { content: string }[]
  }): Promise<{ messages: { text: string }[] }> {
    this.prompts.push(
      input.messages.map((message) => message.content).join("\n")
    )
    return { messages: [{ text: this.reply }] }
  }

  asAgent(): Agent {
    return this as unknown as Agent
  }
}

interface StoredRow {
  userId: string
  postingId: string
  title: string
  url: string
  payload: unknown
  postedAt?: Date
}

/**
 * Just enough Postgres for the two calls this action makes.
 *
 * `postingPayload` is a `findUnique` on the natural key; `recordLinkedPosting`
 * is raw SQL, so the fake matches on the statement's own conflict target rather
 * than parsing it — the property being faked is `ON CONFLICT DO NOTHING`, and a
 * fake that inserted unconditionally would make the duplicate case untestable.
 */
class FakePostings {
  readonly rows: StoredRow[] = []
  readonly inserts: StoredRow[] = []
  /** The account's title filter, and whether reading it works at all. */
  private exclusions: string[] = []
  private filtersUnreadable = false

  seed(row: StoredRow): this {
    this.rows.push(row)
    return this
  }

  /** Give this user a saved filter. */
  filtering(...terms: string[]): this {
    this.exclusions = terms
    return this
  }

  /** Make the settings read fail, which must not cost somebody their paste. */
  breakFilters(): this {
    this.filtersUnreadable = true
    return this
  }

  asPrisma(): PrismaClient {
    const held = this.rows
    const inserts = this.inserts

    return {
      postingFilters: {
        findUnique: async () => {
          if (this.filtersUnreadable) {
            throw new Error("the filters table is gone")
          }

          return this.exclusions.length === 0
            ? null
            : { userId: USER_ID, titleExclusions: this.exclusions }
        },
      },
      posting: {
        findUnique: async ({
          where,
        }: {
          where: { userId_postingId: { userId: string; postingId: string } }
        }) => {
          const { userId, postingId } = where.userId_postingId
          return (
            held.find(
              (row) => row.userId === userId && row.postingId === postingId
            ) ?? null
          )
        },
      },
      $executeRaw: async (statement: { values: unknown[] }) => {
        const [userId, postingId, title, , , url, postedAt, payload] =
          statement.values as [
            string,
            string,
            string,
            string,
            string,
            string,
            Date | null,
            string,
          ]

        if (
          held.some(
            (row) => row.userId === userId && row.postingId === postingId
          )
        ) {
          return 0
        }

        const row: StoredRow = {
          userId,
          postingId,
          title,
          url,
          payload: JSON.parse(payload),
          ...(postedAt ? { postedAt } : {}),
        }
        held.push(row)
        inserts.push(row)
        return 1
      },
    } as unknown as PrismaClient
  }
}

interface Harness {
  add: (state: ActionState, formData: FormData) => Promise<ActionState>
  postings: FakePostings
  extractor: FakeExtractor
  /** How many boards were asked. The board path is tried first, so this leads. */
  boardFetches: () => number
  /** How many pages were fetched. The first spend assertion. */
  fetches: () => number
  /** How many times the factory was called. The second. */
  extractorBuilds: () => number
}

function harness(
  options: {
    user?: CurrentUser
    postings?: FakePostings
    /**
     * What the board path answers. Defaults to `unsupported`, which is the
     * truthful answer for the Greenhouse link these tests paste and is what
     * sends every one of them down the fetch-and-extract path.
     */
    board?: PostingFetch
    boardThrows?: Error
    page?: PageExtractResult
    fetchThrows?: Error
  } = {}
): Harness {
  const postings = options.postings ?? new FakePostings()
  const extractor = new FakeExtractor()
  let boardFetches = 0
  let fetches = 0
  let builds = 0

  const actions = createAddByLinkActions({
    getUser: async () => options.user ?? SIGNED_IN,
    getPrisma: () => postings.asPrisma(),
    fetchFromBoard: async () => {
      boardFetches += 1
      if (options.boardThrows) throw options.boardThrows
      return options.board ?? { status: "unsupported" }
    },
    fetchPage: async () => {
      fetches += 1
      if (options.fetchThrows) throw options.fetchThrows
      return (
        options.page ?? {
          status: "extracted",
          page: { url: URL, markdown: PAGE },
        }
      )
    },
    createPostingExtractor: () => {
      builds += 1
      return extractor.asAgent()
    },
    now: () => NOW,
  })

  return {
    add: actions.addPostingByLink,
    postings,
    extractor,
    boardFetches: () => boardFetches,
    fetches: () => fetches,
    extractorBuilds: () => builds,
  }
}

function form(url: string): FormData {
  const data = new FormData()
  data.append("url", url)
  // Nothing else on the form reaches anything. The session says who is adding
  // it and `postingId()` derives the id from the link, server-side.
  data.append("userId", "99999999-8888-4777-8666-555555555555")
  data.append("title", "Something the user typed")
  return data
}

const IDLE: ActionState = { status: "idle" }

function messageOf(state: ActionState): string {
  return state.status === "idle" ? "" : state.message
}

describe("addPostingByLink", () => {
  it("adds the posting the page described", async () => {
    const it_ = harness()

    const state = await it_.add(IDLE, form(URL))

    expect(state.status).toBe("success")
    expect(messageOf(state)).toContain("Backend Engineer")
    expect(messageOf(state)).toContain("Holloway Labs")

    const [row] = it_.postings.inserts
    expect(row?.title).toBe("Backend Engineer")
    expect(row?.url).toBe(URL)
    // Sixteen lowercase hex characters, which is what the column's CHECK and
    // every S3 key segment built from it require.
    expect(row?.postingId).toMatch(/^[0-9a-f]{16}$/)
    // An ISO date the page stated, so the column holds it.
    expect(row?.postedAt?.toISOString()).toBe("2026-08-04T00:00:00.000Z")
  })

  it("stores the URL the user pasted, whatever the model says", async () => {
    const it_ = harness()
    it_.extractor.reply = JSON.stringify({
      kind: "posting",
      posting: {
        ...EXTRACTION.posting,
        url: "https://apply.example.com/somewhere-else",
      },
    })

    await it_.add(IDLE, form(URL))

    // The schema strips it and the action attaches the form's URL. A link off
    // the page — an apply button, a related role — must not become the
    // Posting's address.
    const [row] = it_.postings.inserts
    expect(row?.url).toBe(URL)
    expect(JSON.stringify(row?.payload)).not.toContain("apply.example.com")
  })

  it("never shows the extractor a URL", async () => {
    const it_ = harness()

    await it_.add(IDLE, form(URL))

    const [prompt] = it_.extractor.prompts
    expect(prompt).toContain(PAGE)
    expect(prompt).not.toContain(URL)
  })

  for (const [who, user] of [
    ["a signed-out caller", ANONYMOUS],
    ["a caller off the allowlist", REFUSED],
  ] as const) {
    it(`refuses ${who} before anything else`, async () => {
      const it_ = harness({ user })

      const state = await it_.add(IDLE, form(URL))

      expect(messageOf(state)).toBe(NOT_AUTHORIZED)
      expect(it_.boardFetches()).toBe(0)
      expect(it_.fetches()).toBe(0)
      expect(it_.extractorBuilds()).toBe(0)
      expect(it_.postings.inserts).toHaveLength(0)
    })
  }

  it("refuses what is not a link, and spends nothing on it", async () => {
    for (const bad of [
      "",
      "not a url",
      "seek.com.au/job/1",
      // ⚠️ Every one of these parses as a URL. `z.url()` alone would take them.
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>hi</h1>",
      `https://example.com/${"x".repeat(3_000)}`,
    ]) {
      const it_ = harness()

      const state = await it_.add(IDLE, form(bad))

      expect(state.status).toBe("error")
      expect(it_.boardFetches()).toBe(0)
      expect(it_.fetches()).toBe(0)
      expect(it_.extractorBuilds()).toBe(0)
    }
  })

  /**
   * The assertion the ordering exists for. A second paste of the same link is a
   * thing people do — the first one is still on screen — and it must not cost a
   * page fetch and a model call each time.
   */
  it("answers an advertisement already tracked without spending anything", async () => {
    const postings = new FakePostings()
    const seeded = harness({ postings })
    await seeded.add(IDLE, form(URL))

    const again = harness({ postings })
    const state = await again.add(IDLE, form(URL))

    expect(messageOf(state)).toBe(ALREADY_TRACKED)
    expect(again.boardFetches()).toBe(0)
    expect(again.fetches()).toBe(0)
    expect(again.extractorBuilds()).toBe(0)
    expect(postings.inserts).toHaveLength(1)
  })

  /**
   * The same advertisement under two links. `postingId()` normalises the URL
   * before hashing it, so the tracking parameters a board adds per search do
   * not mint a second Posting — the property that also makes a pasted link and
   * a Run's find agree on one row.
   */
  it("recognises the same advertisement under a tracked URL", async () => {
    const postings = new FakePostings()
    await harness({ postings }).add(IDLE, form(URL))

    const again = harness({ postings })
    const state = await again.add(
      IDLE,
      form(`${URL}?utm_source=newsletter&gclid=abc#apply`)
    )

    expect(messageOf(state)).toBe(ALREADY_TRACKED)
    expect(again.fetches()).toBe(0)
  })

  it("passes on what the fetcher said about a link it could not read", async () => {
    const it_ = harness({
      page: { status: "failed", message: "That link could not be read: 404." },
    })

    const state = await it_.add(IDLE, form(URL))

    // The fetcher's sentence, not one of this module's: a dead link and a
    // sign-in wall are different things to be told.
    expect(messageOf(state)).toBe("That link could not be read: 404.")
    expect(it_.extractorBuilds()).toBe(0)
  })

  it("does not blame the link when the fetcher itself is misconfigured", async () => {
    const it_ = harness({
      fetchThrows: new Error(
        "Tavily rejected the API key (HTTP 401). TAVILY_API_KEY is set but not accepted."
      ),
    })

    const state = await it_.add(IDLE, form(URL))

    // A deployment fault. Telling the user their perfectly good link is broken
    // would send them to fix the one thing that is fine.
    expect(messageOf(state)).toBe("Something went wrong.")
    expect(it_.postings.inserts).toHaveLength(0)
  })

  it("carries the extractor's reason when the page is not one advertisement", async () => {
    const it_ = harness()
    it_.extractor.reply = JSON.stringify({
      kind: "not-a-posting",
      reason: "This is a list of twelve openings.",
    })

    const state = await it_.add(IDLE, form(URL))

    expect(state.status).toBe("error")
    expect(messageOf(state)).toContain("list of twelve openings")
    expect(it_.postings.inserts).toHaveLength(0)
  })

  for (const [what, reply] of [
    ["answers with prose", "Sure! Here is the job:"],
    ["answers with the wrong shape", '{"kind":"posting","posting":{}}'],
    ["answers with nothing", ""],
  ] as const) {
    it(`says one thing when the extractor ${what}`, async () => {
      const it_ = harness()
      it_.extractor.reply = reply

      const state = await it_.add(IDLE, form(URL))

      // One message for three causes: none of them is something the person
      // holding the link can act on differently, and all three have the same
      // remedy. The distinction is in the server log.
      expect(messageOf(state)).toBe(READ_FAILED)
      expect(it_.postings.inserts).toHaveLength(0)
    })
  }

  it("leaves the posted-at column empty when the page spoke in words", async () => {
    const it_ = harness()
    it_.extractor.reply = JSON.stringify({
      kind: "posting",
      posting: { ...EXTRACTION.posting, postedAt: "3 days ago" },
    })

    await it_.add(IDLE, form(URL))

    const [row] = it_.postings.inserts
    // Absent rather than a guess — the model has no clock — and the page's own
    // words survive in the payload for the table to fall back to.
    expect(row?.postedAt).toBeUndefined()
    expect(JSON.stringify(row?.payload)).toContain("3 days ago")
  })

  it("stores no match reason, because there were no criteria", async () => {
    const it_ = harness()

    await it_.add(IDLE, form(URL))

    const [row] = it_.postings.inserts
    expect(row?.payload).not.toHaveProperty("matchReason")
  })

  it("scopes the read to the session's user and not the form's", async () => {
    // Seeded against somebody else, at the same id. It must not be found.
    const postings = new FakePostings().seed({
      userId: "99999999-8888-4777-8666-555555555555",
      postingId: "0123456789abcdef",
      title: "Someone else's",
      url: URL,
      payload: {},
    })

    const it_ = harness({ postings })
    const state = await it_.add(IDLE, form(URL))

    expect(state.status).toBe("success")
    expect(it_.postings.inserts[0]?.userId).toBe(USER_ID)
  })
})

/**
 * The board path, which is the same action taking a shorter route.
 *
 * SEEK and Indeed publish `title`, `company`, `location` and a description as
 * fields, so their answer needs no reading — and the assertions worth making are
 * about what *does not happen*: no page is fetched, and no extractor is built,
 * which is to say no model is paid for and no attacker-written prose reaches
 * one. Everything after the retrieval is shared with the path above and is
 * asserted there.
 */
describe("addPostingByLink, when a board can answer the link", () => {
  const SEEK_URL = "https://www.seek.com.au/job/93431609?type=standard"

  const FROM_BOARD: PostingFetch = {
    status: "fetched",
    board: "SEEK",
    posting: {
      title: "Senior Backend Engineer",
      company: "Holloway Labs",
      location: "Sydney NSW",
      url: SEEK_URL,
      summary: "Own the data platform.",
      postedAt: "2026-08-04T02:11:00.000Z",
      highlights: ["TypeScript and Postgres"],
    },
  }

  it("stores the board's own fields without reading a page or building a model", async () => {
    const it_ = harness({ board: FROM_BOARD })

    const state = await it_.add(IDLE, form(SEEK_URL))

    expect(state.status).toBe("success")
    expect(messageOf(state)).toContain("Senior Backend Engineer")

    expect(it_.boardFetches()).toBe(1)
    expect(it_.fetches()).toBe(0)
    expect(it_.extractorBuilds()).toBe(0)

    const [row] = it_.postings.inserts
    expect(row?.title).toBe("Senior Backend Engineer")
    expect(row?.url).toBe(SEEK_URL)
    expect(row?.postedAt?.toISOString()).toBe("2026-08-04T02:11:00.000Z")
    expect(row?.payload).toMatchObject({
      highlights: ["TypeScript and Postgres"],
    })
    // No criteria stood behind a pasted link on either path.
    expect(row?.payload).not.toHaveProperty("matchReason")
  })

  /**
   * ⚠️ **No second retrieval after a board's failure.** The route's
   * `maxDuration` is 60 seconds and it has already spent some of them; the
   * general fetcher is also the path least likely to get past the board that
   * just refused, which is why the scout reaches these boards through actors at
   * all.
   */
  it("reports a board's failure rather than trying the page fetcher after it", async () => {
    const it_ = harness({
      board: {
        status: "failed",
        message:
          "That SEEK link did not resolve to a single job advertisement. Paste the link to one posting rather than to a search or a company page.",
      },
    })

    const state = await it_.add(IDLE, form(SEEK_URL))

    expect(state.status).toBe("error")
    expect(messageOf(state)).toContain("single job advertisement")
    expect(it_.fetches()).toBe(0)
    expect(it_.extractorBuilds()).toBe(0)
    expect(it_.postings.inserts).toHaveLength(0)
  })

  it("does not blame the link when the board fetcher is misconfigured", async () => {
    const it_ = harness({
      boardThrows: new Error(
        "Apify rejected the API token (HTTP 401). APIFY_TOKEN is set but not accepted."
      ),
    })

    const state = await it_.add(IDLE, form(SEEK_URL))

    // Same split as the page fetcher's: a deployment fault is not a broken
    // link, and reporting it as one sends somebody to fix the thing that works.
    expect(messageOf(state)).toBe("Something went wrong.")
    expect(it_.fetches()).toBe(0)
    expect(it_.postings.inserts).toHaveLength(0)
  })

  /**
   * LinkedIn, Greenhouse, a company careers page — everything no board actor can
   * be handed a single posting for. The board is asked, answers `unsupported`,
   * and the general path runs exactly as it did before this branch existed.
   */
  it("falls through to the page fetcher for a link no board can answer", async () => {
    const it_ = harness({ board: { status: "unsupported" } })

    const state = await it_.add(IDLE, form(URL))

    expect(state.status).toBe("success")
    expect(it_.boardFetches()).toBe(1)
    expect(it_.fetches()).toBe(1)
    expect(it_.extractorBuilds()).toBe(1)
  })
})

/**
 * The account-wide title filter, met on the way in.
 *
 * The Postings table hides a row whose title carries one of these words, so
 * adding one would write a row that is invisible the instant it exists — the
 * user pastes a link, is told it was added, and finds nothing. Every assertion
 * here is about that trade being made deliberately.
 */
describe("addPostingByLink, against the user's title filters", () => {
  const SEEK_URL = "https://www.seek.com.au/job/93431609?type=standard"

  const SENIOR: PostingFetch = {
    status: "fetched",
    board: "SEEK",
    posting: {
      title: "Senior Backend Engineer",
      company: "Holloway Labs",
      location: "Sydney NSW",
      url: SEEK_URL,
      summary: "Own the data platform.",
    },
  }

  it("refuses a posting its own title would hide, and names the word", async () => {
    const it_ = harness({
      board: SENIOR,
      postings: new FakePostings().filtering("senior"),
    })

    const state = await it_.add(IDLE, form(SEEK_URL))

    expect(state.status).toBe("error")
    expect(messageOf(state)).toContain("senior")
    expect(messageOf(state)).toContain("Senior Backend Engineer")
    // Nothing written: a row nobody can see is worse than a refusal that says
    // why, and the word was probably set weeks ago about a different search.
    expect(it_.postings.inserts).toHaveLength(0)
  })

  it("checks the title the advertisement carries, not the link", async () => {
    // The URL says nothing about seniority; the board's answer does. Checking
    // before the fetch would be a different rule, and a wrong one.
    const it_ = harness({
      board: SENIOR,
      postings: new FakePostings().filtering("senior"),
    })

    await it_.add(IDLE, form(SEEK_URL))

    expect(it_.boardFetches()).toBe(1)
  })

  it("adds a posting no filter matches", async () => {
    const it_ = harness({
      board: SENIOR,
      postings: new FakePostings().filtering("principal", "graduate"),
    })

    const state = await it_.add(IDLE, form(SEEK_URL))

    expect(state.status).toBe("success")
    expect(it_.postings.inserts).toHaveLength(1)
  })

  it("matches whole words, so a substring does not cost a paste", async () => {
    const it_ = harness({
      board: SENIOR,
      // Inside "engineer", and not a word of the title.
      postings: new FakePostings().filtering("gin"),
    })

    const state = await it_.add(IDLE, form(SEEK_URL))

    expect(state.status).toBe("success")
  })

  it("still adds the posting when the filters cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const it_ = harness({
      board: SENIOR,
      postings: new FakePostings().breakFilters(),
    })

    const state = await it_.add(IDLE, form(SEEK_URL))

    // The filter is about tidying a list. Losing a settings read must not cost
    // somebody the advertisement they explicitly asked for.
    expect(state.status).toBe("success")
    expect(error).toHaveBeenCalled()
  })
})
