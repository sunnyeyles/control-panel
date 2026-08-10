import { describe, expect, it } from "vitest"

import {
  BOARDS_FETCHED_BY_URL,
  fetchPostingByUrl,
  type PostingFetchDeps,
} from "./board-fetch.ts"
import { JOB_BOARDS } from "./job-boards.ts"
import { postingId } from "./posting-id.ts"
import { StoredPostingSchema } from "./stored-posting.ts"

/**
 * Which board answers a pasted link, and what it is allowed to answer with.
 *
 * The wiring is the subject here — `board-posting.test.ts` in
 * `@workspace/agent-tools` covers what an actor run does with its reply. What
 * this suite is for is the three joins that only exist in this module: host to
 * board, board to actor, and the board's answer to the platform's own Posting
 * shape.
 */

const TOKEN = "apify-test-token"

interface Capture {
  url: string
  body: Record<string, unknown>
}

/** A `fetch` that records the run and replies with one dataset. */
function fakeFetch(items: unknown[], captured: Capture[]): PostingFetchDeps {
  return {
    apiToken: TOKEN,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch,
  }
}

const SEEK_URL = "https://www.seek.com.au/job/93431609"

const SEEK_ITEM = {
  title: "Senior Backend Engineer",
  company: "Holloway Labs",
  location: "Sydney NSW",
  url: SEEK_URL,
  publishDateISO: "2026-08-04T02:11:00.000Z",
  teaser: "Own the data platform behind a product used by half the country.",
  bulletPoints: ["TypeScript and Postgres"],
  descriptionMarkdown: "## About the role\n\nA long advertisement.",
}

describe("fetchPostingByUrl", () => {
  it("routes a SEEK link to SEEK's actor and returns a Posting", async () => {
    const captured: Capture[] = []

    const result = await fetchPostingByUrl(
      SEEK_URL,
      fakeFetch([SEEK_ITEM], captured)
    )

    expect(captured[0]!.url).toContain("unfenced-group~seek-com-au-scraper")
    expect(result).toEqual({
      status: "fetched",
      board: "SEEK",
      posting: {
        title: "Senior Backend Engineer",
        company: "Holloway Labs",
        location: "Sydney NSW",
        url: SEEK_URL,
        summary:
          "Own the data platform behind a product used by half the country.",
        postedAt: "2026-08-04T02:11:00.000Z",
        highlights: ["TypeScript and Postgres"],
      },
    })
  })

  /**
   * ⚠️ **The one field on this path that is derived rather than published, and
   * the only place in the system that derivation is allowed to run.** Every
   * other producer of a Posting has a model that was shown the advertisement and
   * is instructed to copy the phrase; this path deliberately has none, so
   * `findExperienceStatement` reads it off what the board did publish. Running
   * that pattern anywhere else would be a second rule producing the same field,
   * and the two would disagree about the same advertisement depending on which
   * path found it.
   */
  it("reads the stated experience off what the board published", async () => {
    const result = await fetchPostingByUrl(
      SEEK_URL,
      fakeFetch(
        [{ ...SEEK_ITEM, bulletPoints: ["5+ years of experience with Go"] }],
        []
      )
    )

    expect(result.status === "fetched" && result.posting.experience).toBe(
      "5+ years of experience"
    )
  })

  it("leaves the field out when the board published no requirement", async () => {
    // Absent is the ordinary answer, and the field is optional so that saying
    // nothing is expressible. A number invented from the title would be a fact
    // about somebody's job that nobody stated.
    const result = await fetchPostingByUrl(SEEK_URL, fakeFetch([SEEK_ITEM], []))

    expect(result.status === "fetched" && result.posting).not.toHaveProperty(
      "experience"
    )
  })

  /**
   * ⚠️ **The stored URL is the one that was pasted, not the one the board
   * reported.** They are the same advertisement — the identity check upstream
   * proved it — and keeping the caller's is what makes a link and a Run's later
   * find agree on one `postingId` and merge into one row. It is also the same
   * rule the extractor path follows for the same reason.
   *
   * The link below is the shape SEEK actually puts in a person's address bar,
   * and the actor reports the bare canonical form — so this is the ordinary
   * case, not an edge one. It only works because `type` is on SEEK's
   * `trackingParameters`; see `job-boards.ts`.
   */
  it("carries the pasted URL through, tracking parameters and all", async () => {
    const pasted = `${SEEK_URL}?type=standard&ref=search-standalone`
    const captured: Capture[] = []

    const result = await fetchPostingByUrl(
      pasted,
      fakeFetch([SEEK_ITEM], captured)
    )

    expect(result.status === "fetched" && result.posting.url).toBe(pasted)
    // And the merge property that depends on it: the same advertisement found
    // later by a Run is one row with this one, not a second.
    expect(postingId({ url: pasted })).toBe(postingId({ url: SEEK_URL }))
  })

  it("accepts an Indeed link copied out of a browser", async () => {
    const canonical = "https://au.indeed.com/viewjob?jk=8f21c0d5aa11be32"
    const pasted = `${canonical}&from=serp&tk=1iaq0ck9tk3ma801`

    const result = await fetchPostingByUrl(
      pasted,
      fakeFetch(
        [
          {
            url: canonical,
            positionName: "Platform Engineer",
            company: "Northbay",
            location: "Melbourne VIC",
            description: "Look after our deployment pipeline.",
          },
        ],
        []
      )
    )

    expect(result.status).toBe("fetched")
    expect(postingId({ url: pasted })).toBe(postingId({ url: canonical }))
  })

  /**
   * A Posting added by link was matched against no criteria, so there is nothing
   * for `matchReason` to be — and the board has no opinion to borrow. Its
   * absence is why `StoredPostingSchema` exists at all.
   */
  it("returns no match reason, because nobody stated any criteria", async () => {
    const result = await fetchPostingByUrl(SEEK_URL, fakeFetch([SEEK_ITEM], []))

    expect(result.status === "fetched" && result.posting).not.toHaveProperty(
      "matchReason"
    )
    expect(
      StoredPostingSchema.safeParse(
        result.status === "fetched" ? result.posting : undefined
      ).success
    ).toBe(true)
  })

  it("resolves a board reached under one of its other hostnames", async () => {
    const captured: Capture[] = []
    const url = "https://au.indeed.com/viewjob?jk=8f21c0d5aa11be32"

    const result = await fetchPostingByUrl(
      url,
      fakeFetch(
        [
          {
            url,
            positionName: "Platform Engineer",
            company: "Northbay",
            location: "Melbourne VIC",
            description: "Look after our deployment pipeline.",
          },
        ],
        captured
      )
    )

    expect(captured[0]!.url).toContain("misceres~indeed-scraper")
    expect(result.status === "fetched" && result.board).toBe("Indeed")
  })

  /**
   * The three ways a link falls past every board, each spending nothing. The
   * caller reads `unsupported` as "use the general page fetcher", which is what
   * makes all three the same answer here.
   */
  it.each([
    [
      "a board with no direct-URL fetch",
      "https://www.linkedin.com/jobs/view/4012345678",
    ],
    [
      "a host no board claims",
      "https://boards.greenhouse.io/holloway/jobs/401",
    ],
    [
      "a host that merely ends in a board's name",
      "https://notseek.com.au/job/1",
    ],
    ["a URL that will not parse", "not a url at all"],
  ])("reports %s as unsupported, without a request", async (_name, url) => {
    const captured: Capture[] = []

    const result = await fetchPostingByUrl(url, fakeFetch([], captured))

    expect(result).toEqual({ status: "unsupported" })
    expect(captured).toHaveLength(0)
  })

  it("passes a board's failure through in the board's own words", async () => {
    const result = await fetchPostingByUrl(SEEK_URL, fakeFetch([], []))

    expect(result.status).toBe("failed")
    expect(result.status === "failed" && result.message).toContain("board")
  })

  /**
   * A dataset item is JSON off a community-maintained scraper, so its declared
   * shape is a description of what was observed rather than a guarantee. A field
   * of the wrong type is treated as a field that is missing — the answer stays a
   * valid Posting rather than becoming a thrown error, which the Server Action
   * would report as "something went wrong" over a link that is fine.
   */
  it("treats a field of the wrong type as one the board did not publish", async () => {
    const result = await fetchPostingByUrl(
      SEEK_URL,
      fakeFetch(
        [
          {
            ...SEEK_ITEM,
            company: { name: "Holloway Labs" },
            location: 7,
            publishDateISO: { $date: "2026-08-04" },
            bulletPoints: [null, "TypeScript and Postgres"],
          },
        ],
        []
      )
    )

    expect(result.status).toBe("fetched")
    expect(result.status === "fetched" && result.posting).toMatchObject({
      title: "Senior Backend Engineer",
      company: "Unknown",
      location: "Unknown",
      highlights: ["TypeScript and Postgres"],
    })
    expect(result.status === "fetched" && result.posting).not.toHaveProperty(
      "postedAt"
    )
    expect(
      StoredPostingSchema.safeParse(
        result.status === "fetched" ? result.posting : undefined
      ).success
    ).toBe(true)
  })
})

/**
 * The registry is keyed by `JobBoard.name`, which is a string agreement between
 * two files. This is what stops a typo silently routing a board's links to the
 * general fetcher — a failure that looks exactly like the feature working.
 */
describe("BOARDS_FETCHED_BY_URL", () => {
  it("names only boards JOB_BOARDS knows", () => {
    const known = JOB_BOARDS.map((board) => board.name)

    for (const name of BOARDS_FETCHED_BY_URL) {
      expect(known).toContain(name)
    }
  })

  it("is SEEK and Indeed, and deliberately not LinkedIn", () => {
    expect([...BOARDS_FETCHED_BY_URL].sort()).toEqual(["Indeed", "SEEK"])
  })
})
