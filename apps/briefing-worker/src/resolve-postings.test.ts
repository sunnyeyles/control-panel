import type { ScoutFindings, ScoutPosting } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import { resolvePostings, type PostingLookup } from "./resolve-postings.ts"

/**
 * The URLs here are real shapes, not shortened ones, and that is deliberate:
 * every production failure this module was written for came from the *length*
 * of a LinkedIn URL. Nothing types one any more — which is the point — but what
 * a resolved posting carries is still the whole thing, decoration and all.
 *
 * That an id survives LinkedIn's per-search decoration is `posting-id.test.ts`'s
 * property, not this module's. Here the catalog is a fake, because what is under
 * test is what happens to a reported posting once its id resolves or does not.
 */

const LINKEDIN_URL =
  "https://au.linkedin.com/jobs/view/software-engineer-at-resmed-4438146498?position=58&pageNum=0&refId=vwiYgyFWH4ledCean93oRw%3D%3D&trackingId=%2FgP%2F0U3muqlhUPsortF6PA%3D%3D"

const INDEED_URL = "https://au.indeed.com/viewjob?jk=40288faae871cc95"

/** A catalog holding exactly the postings a search returned. */
function catalogOf(entries: Record<string, string>): PostingLookup {
  return { get: (id) => (entries[id] ? { url: entries[id] } : undefined) }
}

function posting(id: string, title = "Software Engineer"): ScoutPosting {
  return {
    id,
    title,
    company: "ResMed",
    location: "Sydney",
    summary: "Building things.",
    matchReason: "Matches the title and location.",
  }
}

function findings(...postings: ScoutPosting[]): ScoutFindings {
  return { postings, notes: "Searched three boards." }
}

describe("resolvePostings", () => {
  it("gives a reported posting the URL the board issued", () => {
    const resolved = resolvePostings(
      findings(posting("7f3a91c2")),
      catalogOf({ "7f3a91c2": LINKEDIN_URL })
    )

    expect(resolved.dropped).toEqual([])
    expect(resolved.findings.postings[0]?.url).toBe(LINKEDIN_URL)
  })

  it("keeps everything the scout composed about the posting", () => {
    const resolved = resolvePostings(
      findings({
        ...posting("7f3a91c2"),
        postedAt: "2026-08-04",
        highlights: ["Ship features end to end."],
      }),
      catalogOf({ "7f3a91c2": LINKEDIN_URL })
    )

    expect(resolved.findings.postings[0]).toEqual({
      title: "Software Engineer",
      company: "ResMed",
      location: "Sydney",
      summary: "Building things.",
      matchReason: "Matches the title and location.",
      postedAt: "2026-08-04",
      highlights: ["Ship features end to end."],
      url: LINKEDIN_URL,
    })
  })

  it("does not carry the id into the stored posting", () => {
    // Downstream a posting is identified by `postingId(url)`, which is where
    // this id came from. Storing both would be storing one fact twice.
    const resolved = resolvePostings(
      findings(posting("7f3a91c2")),
      catalogOf({ "7f3a91c2": LINKEDIN_URL })
    )

    expect(resolved.findings.postings[0]).not.toHaveProperty("id")
  })

  it("carries the rest of the findings through untouched", () => {
    const resolved = resolvePostings(
      findings(posting("7f3a91c2")),
      catalogOf({ "7f3a91c2": LINKEDIN_URL })
    )

    expect(resolved.findings.notes).toBe("Searched three boards.")
  })

  it("drops an id no search returned", () => {
    // The fabrication this gate exists for. An id is sixteen hex characters
    // that nothing but a search can produce, so an invented one names nothing.
    const invented = posting("deadbeefdeadbeef", "Staff Engineer")

    const resolved = resolvePostings(
      findings(posting("7f3a91c2"), invented),
      catalogOf({ "7f3a91c2": LINKEDIN_URL })
    )

    expect(resolved.dropped).toEqual([invented])
    expect(resolved.findings.postings).toHaveLength(1)
  })

  it("resolves against every board's results, not one", () => {
    const resolved = resolvePostings(
      findings(posting("7f3a91c2"), posting("a1b2c3d4", "Backend Engineer")),
      catalogOf({ "7f3a91c2": LINKEDIN_URL, a1b2c3d4: INDEED_URL })
    )

    expect(resolved.dropped).toEqual([])
    expect(resolved.findings.postings.map((p) => p.url)).toEqual([
      LINKEDIN_URL,
      INDEED_URL,
    ])
  })

  it("keeps the order the scout reported, which is its ranking", () => {
    const resolved = resolvePostings(
      findings(posting("a1b2c3d4", "Best"), posting("7f3a91c2", "Second")),
      catalogOf({ "7f3a91c2": LINKEDIN_URL, a1b2c3d4: INDEED_URL })
    )

    expect(resolved.findings.postings.map((p) => p.title)).toEqual([
      "Best",
      "Second",
    ])
  })

  it("accounts for nothing when the scout found nothing", () => {
    const resolved = resolvePostings(
      findings(),
      catalogOf({ "7f3a91c2": LINKEDIN_URL })
    )

    expect(resolved.dropped).toEqual([])
    expect(resolved.findings.postings).toEqual([])
  })

  it("drops everything when no search returned at all", () => {
    const reported = posting("7f3a91c2")

    expect(resolvePostings(findings(reported), catalogOf({}))).toEqual({
      findings: { postings: [], notes: "Searched three boards." },
      dropped: [reported],
    })
  })
})
