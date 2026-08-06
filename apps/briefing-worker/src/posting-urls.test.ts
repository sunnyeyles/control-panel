import type { Findings, Posting } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import { verifyPostingUrls } from "./posting-urls.ts"
import type { SearchResult } from "./search-results.ts"

/**
 * The URLs here are real shapes, not shortened ones, and that is deliberate:
 * every production failure this module was written for came from the *length*
 * of a LinkedIn URL, so a fixture that trims the tracking parameters away would
 * test a case that never happens.
 */

const LINKEDIN_URL =
  "https://au.linkedin.com/jobs/view/software-engineer-at-resmed-4438146498?position=58&pageNum=0&refId=vwiYgyFWH4ledCean93oRw%3D%3D&trackingId=%2FgP%2F0U3muqlhUPsortF6PA%3D%3D"

const INDEED_URL = "https://au.indeed.com/viewjob?jk=40288faae871cc95"

function posting(url: string, title = "Software Engineer"): Posting {
  return {
    title,
    company: "ResMed",
    location: "Sydney",
    url,
    summary: "Building things.",
    matchReason: "Matches the title and location.",
  }
}

function findings(...postings: Posting[]): Findings {
  return { postings, notes: "Searched three boards." }
}

/** One result, rendered the way `apify-search.ts` renders one. */
function result(...urls: string[]): SearchResult {
  return {
    tool: "linkedin_search",
    text: [
      `${urls.length} currently-listed posting(s) for "software engineer":`,
      ...urls.map(
        (url, index) => `${index + 1}. A role — A company\n   ${url}`
      ),
    ].join("\n\n"),
  }
}

describe("verifyPostingUrls", () => {
  it("keeps a posting a search returned", () => {
    const verified = verifyPostingUrls(findings(posting(LINKEDIN_URL)), [
      result(LINKEDIN_URL),
    ])

    expect(verified.dropped).toEqual([])
    expect(verified.findings.postings).toEqual([posting(LINKEDIN_URL)])
  })

  it("carries the rest of the findings through untouched", () => {
    const verified = verifyPostingUrls(findings(posting(INDEED_URL)), [
      result(INDEED_URL),
    ])

    expect(verified.findings.notes).toBe("Searched three boards.")
  })

  it("drops a posting no search returned", () => {
    const invented = posting("https://example.com/jobs/999")

    const verified = verifyPostingUrls(
      findings(posting(LINKEDIN_URL), invented),
      [result(LINKEDIN_URL)]
    )

    expect(verified.dropped).toEqual([invented])
    expect(verified.findings.postings).toEqual([posting(LINKEDIN_URL)])
  })

  it("drops a LinkedIn slug carrying another board's job key", () => {
    // The 2026-08-06 production failure, exactly: `40288faae871cc95` is the
    // Indeed key from the result beside it, grafted onto a LinkedIn slug. This
    // is the fabrication the gate exists for, and loosening the comparison to
    // posting identity must not let it through.
    const grafted = posting(
      "https://au.linkedin.com/jobs/view/senior-software-engineer-at-lorikeet-40288faae871cc95"
    )

    const verified = verifyPostingUrls(findings(grafted), [result(INDEED_URL)])

    expect(verified.dropped).toEqual([grafted])
    expect(verified.findings.postings).toEqual([])
  })

  describe("matches on posting identity rather than on bytes, so it keeps", () => {
    /**
     * Each of these is a transcription slip observed in production between
     * 2026-08-05 and 2026-08-06. The posting is real and the search returned
     * it; only LinkedIn's per-search decoration came back changed.
     */
    const slips: [name: string, reported: string][] = [
      [
        "a mistyped position",
        LINKEDIN_URL.replace("position=58", "position=59"),
      ],
      [
        "another posting's trackingId",
        LINKEDIN_URL.replace(
          "trackingId=%2FgP%2F0U3muqlhUPsortF6PA%3D%3D",
          "trackingId=aRwy7bqzDR%2BNCHPbwDncuw%3D%3D"
        ),
      ],
      [
        "the tracking parameters dropped altogether",
        LINKEDIN_URL.split("?")[0]!,
      ],
      [
        "the parameters reordered",
        LINKEDIN_URL.replace(
          "?position=58&pageNum=0",
          "?pageNum=0&position=58"
        ),
      ],
    ]

    for (const [name, reported] of slips) {
      it(name, () => {
        const verified = verifyPostingUrls(findings(posting(reported)), [
          result(LINKEDIN_URL),
        ])

        expect(verified.dropped).toEqual([])
        // And the URL is the board's, not the scout's — a brief must link to
        // what LinkedIn issued rather than to what the model typed.
        expect(verified.findings.postings[0]?.url).toBe(LINKEDIN_URL)
      })
    }
  })

  it("keeps a slug whose emoji the scout percent-encoded", () => {
    // 2026-08-06T01:00 in production. The actor returns the emoji raw; the
    // model wrote it back escaped, which `new URL()` treats as the same URL
    // and byte comparison does not.
    const issued =
      "https://au.linkedin.com/jobs/view/senior-full-stack-software-engineer-typescript-🚀-at-thedrivegroup-4373316067?position=57"
    const escaped =
      "https://au.linkedin.com/jobs/view/senior-full-stack-software-engineer-typescript-%F0%9F%9A%80-at-thedrivegroup-4373316067?position=57"

    const verified = verifyPostingUrls(findings(posting(escaped)), [
      result(issued),
    ])

    expect(verified.dropped).toEqual([])
    expect(verified.findings.postings[0]?.url).toBe(issued)
  })

  it("drops a URL truncated mid-id, which is a different posting", () => {
    // Also production, 2026-08-05T14:00. Nothing distinguishes a truncated id
    // from a wrong one, so this stays a drop rather than a repair.
    const truncated = posting(
      "https://au.linkedin.com/jobs/view/software-engineer-at-resmed-444?"
    )

    const verified = verifyPostingUrls(findings(truncated), [
      result(LINKEDIN_URL),
    ])

    expect(verified.dropped).toEqual([truncated])
  })

  it("reads URLs out of every result, not only the first", () => {
    const verified = verifyPostingUrls(
      findings(posting(INDEED_URL), posting(LINKEDIN_URL)),
      [
        result(LINKEDIN_URL),
        { tool: "indeed_search", text: result(INDEED_URL).text },
      ]
    )

    expect(verified.dropped).toEqual([])
    expect(verified.findings.postings).toHaveLength(2)
  })

  it("finds a URL that ends a sentence in an advertisement's description", () => {
    // Descriptions are prose copied from the advertisement, so a URL inside one
    // can be followed by a full stop that is not part of it.
    const verified = verifyPostingUrls(findings(posting(INDEED_URL)), [
      { tool: "indeed_search", text: `Apply at ${INDEED_URL}. No agencies.` },
    ])

    expect(verified.dropped).toEqual([])
  })

  it("accounts for nothing when the scout found nothing", () => {
    const verified = verifyPostingUrls(findings(), [result(LINKEDIN_URL)])

    expect(verified.dropped).toEqual([])
    expect(verified.findings.postings).toEqual([])
  })

  it("drops everything when no search returned at all", () => {
    const reported = posting(LINKEDIN_URL)

    expect(verifyPostingUrls(findings(reported), [])).toEqual({
      findings: { postings: [], notes: "Searched three boards." },
      dropped: [reported],
    })
  })
})
