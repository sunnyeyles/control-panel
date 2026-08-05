import { afterEach, describe, expect, it } from "vitest"

import { apifyLinkedinSearch } from "./linkedin-search.ts"

/**
 * What is true of LinkedIn and of no other board: the actor it runs, the search
 * *URL* it has to compose because that actor takes no search parameters, the
 * floor that actor puts under `count`, and which of its fields carry the title,
 * the URL and the description. The token handling, the clamp, the failure
 * split, the truncation and the rendering are shared, and
 * `apify-search.test.ts` owns them — including the floor's mechanics; what is
 * asserted here is that this board declares one.
 *
 * Driven through `apifyLinkedinSearch` rather than the tool wrapper, exactly as
 * `seek-search.test.ts` does it: a tool's schema describes what the *model*
 * passes and has nowhere to carry a fake `fetch`.
 */

const API_TOKEN = "apify-test-token"

interface Capture {
  url: string
  init: RequestInit
}

function fakeFetch(reply: Response, captured: Capture[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    // Cloned, not returned directly: a Response body reads once, and some tests
    // drive the same fake through several calls.
    return reply.clone()
  }) as unknown as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function requestBody(capture: Capture): Record<string, unknown> {
  return JSON.parse(String(capture.init.body)) as Record<string, unknown>
}

/** The one search URL the actor was pointed at. */
function searchUrl(capture: Capture): string {
  const urls = requestBody(capture).urls
  expect(Array.isArray(urls)).toBe(true)
  return String((urls as unknown[])[0])
}

/**
 * One item, shaped as the actor's dataset returns it: a bare array, the URL on
 * `au.linkedin.com` with per-search tracking parameters attached, and an
 * `applyUrl` that was empty on every posting measured on 2026-08-05.
 */
const ONE_JOB = [
  {
    title: "Software Engineer",
    companyName: "Simplus ANZ",
    location: "Sydney, New South Wales, Australia",
    link: "https://au.linkedin.com/jobs/view/software-engineer-at-simplus-anz-4446494860?position=60&pageNum=0&refId=Is5ZuQho&trackingId=D%2BHsFbhL",
    postedAt: "2026-07-30",
    employmentType: "Full-time",
    seniorityLevel: "Mid-Senior level",
    salary: "$120,000 - $140,000",
    descriptionText: "Build TypeScript services in a small product team.",
    applyUrl: "",
  },
]

/** Ten, for the runs that exercise the actor's `count` floor. */
const TEN_JOBS = Array.from({ length: 10 }, (_, index) => ({
  title: `Job ${index}`,
  companyName: "Acme",
  link: `https://au.linkedin.com/jobs/view/job-${index}`,
}))

afterEach(() => {
  delete process.env.APIFY_TOKEN
})

describe("apifyLinkedinSearch", () => {
  it("points LinkedIn's actor at a composed search URL and renders its fields", async () => {
    const captured: Capture[] = []

    const output = await apifyLinkedinSearch(
      {
        query: "software engineer TypeScript",
        location: "Sydney, New South Wales, Australia",
      },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toContain(
      "api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/run-sync-get-dataset-items"
    )

    // Unlike SEEK's and Indeed's, this actor takes no search parameters at all
    // — a prebuilt search page and a count is the entire input.
    const body = requestBody(captured[0]!)
    expect(body.scrapeCompany).toBe(false)
    expect(searchUrl(captured[0]!)).toContain(
      "https://www.linkedin.com/jobs/search/?keywords=software%20engineer%20TypeScript&location=Sydney%2C%20New%20South%20Wales%2C%20Australia"
    )

    // The URL is the traceability requirement — a result the brief cannot link
    // to is not usable downstream. The listing date is the freshness evidence.
    expect(output).toContain(
      "https://au.linkedin.com/jobs/view/software-engineer-at-simplus-anz-4446494860?position=60&pageNum=0&refId=Is5ZuQho&trackingId=D%2BHsFbhL"
    )
    expect(output).toContain("Software Engineer — Simplus ANZ")
    expect(output).toContain("listed: 2026-07-30")
    expect(output).toContain(
      "Sydney, New South Wales, Australia · Full-time · Mid-Senior level · $120,000 - $140,000"
    )
    expect(output).toContain("Build TypeScript services")
  })

  it("reports the URL the actor returned, tracking parameters and all", async () => {
    const output = await apifyLinkedinSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), []) }
    )

    // The host is `au.linkedin.com` although the search asked
    // `www.linkedin.com`, and `refId`/`trackingId` are regenerated per search.
    // Neither is edited here: stabilising posting identity across those
    // parameters is done per-host in `packages/agents/src/job-boards.ts`, and a
    // URL this tool rewrote would be a URL the board never issued.
    expect(output).toContain("au.linkedin.com")
    expect(output).toContain("refId=Is5ZuQho")
  })

  it("never reads applyUrl, which is empty on every result", async () => {
    const withApplyUrl = [
      {
        ...ONE_JOB[0],
        applyUrl: "https://example.com/apply/should-not-appear",
      },
    ]

    const output = await apifyLinkedinSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(withApplyUrl), []) }
    )

    // Measured empty on every posting on 2026-08-05, so `link` is the posting
    // and this field is not read even when the actor fills it in.
    expect(output).not.toContain("should-not-appear")
  })

  it("bakes the freshness bound into the URL as LinkedIn's seconds filter", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_JOB), captured)

    await apifyLinkedinSearch({ query: "a" }, { apiToken: API_TOKEN, fetch })
    await apifyLinkedinSearch(
      { query: "b", daysOld: 7 },
      { apiToken: API_TOKEN, fetch }
    )

    // `f_TPR=r<seconds>`, not days: 30 days is r2592000 and a week is r604800.
    expect(searchUrl(captured[0]!)).toContain("f_TPR=r2592000")
    expect(searchUrl(captured[1]!)).toContain("f_TPR=r604800")
  })

  it("translates workType into an f_JT code, and omits the filter without one", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(ONE_JOB), captured)

    await apifyLinkedinSearch(
      { query: "a", workType: "Contract" },
      { apiToken: API_TOKEN, fetch }
    )
    await apifyLinkedinSearch(
      { query: "b", workType: "Full time" },
      { apiToken: API_TOKEN, fetch }
    )
    await apifyLinkedinSearch({ query: "c" }, { apiToken: API_TOKEN, fetch })

    // The single-letter codes are LinkedIn's vocabulary and never leave this
    // module — the model asks for "Contract" on every board.
    expect(searchUrl(captured[0]!)).toContain("f_JT=C")
    expect(searchUrl(captured[1]!)).toContain("f_JT=F")
    expect(searchUrl(captured[2]!)).not.toContain("f_JT")
  })

  it("bounds a locationless search to Australia rather than the world", async () => {
    const captured: Capture[] = []

    await apifyLinkedinSearch(
      { query: "a" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    // LinkedIn searches worldwide without a location, which would make this the
    // one board that answered a bare query with postings in countries nobody
    // asked about. SEEK and Indeed are both pinned to Australia.
    expect(searchUrl(captured[0]!)).toContain("location=Australia")
  })

  it("escapes the keywords and location rather than pasting them in", async () => {
    const captured: Capture[] = []

    await apifyLinkedinSearch(
      { query: "C++ & Rust", location: "Sydney, NSW" },
      { apiToken: API_TOKEN, fetch: fakeFetch(jsonResponse(ONE_JOB), captured) }
    )

    // A bare `&` or `+` in a query string is a parameter separator and a space
    // — an unescaped title would silently search for something else.
    const url = searchUrl(captured[0]!)
    expect(url).toContain("keywords=C%2B%2B%20%26%20Rust")
    expect(url).toContain("location=Sydney%2C%20NSW")
    expect(new URL(url).searchParams.get("keywords")).toBe("C++ & Rust")
  })

  it("asks for the actor's ten-item floor while returning what was requested", async () => {
    const captured: Capture[] = []

    const output = await apifyLinkedinSearch(
      { query: "a", maxResults: 3 },
      {
        apiToken: API_TOKEN,
        fetch: fakeFetch(jsonResponse(TEN_JOBS), captured),
      }
    )

    // Below ten the actor refuses to run at all — `Field input.count must be
    // >= 10` — so a small search asks for ten and drops the surplus. The floor
    // must not reach the schema the model reads.
    expect(requestBody(captured[0]!).count).toBe(10)
    expect(output).toContain("3 currently-listed posting(s)")
    expect(output).toContain("Job 2")
    expect(output).not.toContain("Job 3")
  })

  it("asks for exactly what was requested once it clears the floor", async () => {
    const captured: Capture[] = []
    const fetch = fakeFetch(jsonResponse(TEN_JOBS), captured)

    await apifyLinkedinSearch(
      { query: "a", maxResults: 25 },
      { apiToken: API_TOKEN, fetch }
    )
    await apifyLinkedinSearch({ query: "b" }, { apiToken: API_TOKEN, fetch })

    // The floor is a minimum, not a rewrite: nothing above it is touched, and
    // the default of 20 is already clear of it.
    expect(requestBody(captured[0]!).count).toBe(25)
    expect(requestBody(captured[1]!).count).toBe(20)
  })
})
