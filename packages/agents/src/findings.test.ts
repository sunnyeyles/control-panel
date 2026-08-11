import { describe, expect, it } from "vitest"

import {
  parseFindings,
  PostingSchema,
  ScoutFindingsSchema,
  ScoutPostingSchema,
} from "./findings.ts"
import { JOB_SCOUT_SYSTEM_PROMPT } from "./job-scout.ts"

/**
 * A Posting in the shape every Findings record written before `highlights`
 * existed carries: no such field at all. Old records are re-read — by the dev
 * renderer, by anything replaying a run — so the field being *optional* rather
 * than defaulted is the compatibility guarantee, and it is worth a test that
 * fails loudly if someone tightens it.
 */
const LEGACY_POSTING = {
  title: "Senior Backend Engineer",
  company: "Example Pty Ltd",
  location: "Sydney NSW",
  url: "https://www.seek.com.au/job/123456",
  postedAt: "2026-07-30",
  summary: "Building payment services on a small platform team.",
  matchReason: "Backend, Sydney, and the stack the candidate asked for.",
}

describe("PostingSchema", () => {
  it("parses a Posting written before highlights existed", () => {
    const result = PostingSchema.safeParse(LEGACY_POSTING)

    expect(result.success).toBe(true)
    expect(result.data).not.toHaveProperty("highlights")
  })

  it("parses highlights when the scout copies them", () => {
    const highlights = [
      "5+ years building services in Go or Rust",
      "Hybrid: three days a week in the Sydney office",
    ]

    const result = PostingSchema.safeParse({
      ...LEGACY_POSTING,
      highlights,
    })

    expect(result.success).toBe(true)
    expect(result.data?.highlights).toEqual(highlights)
  })

  it("accepts an empty highlights list without inventing one", () => {
    expect(
      PostingSchema.parse({ ...LEGACY_POSTING, highlights: [] }).highlights
    ).toEqual([])
    expect(PostingSchema.parse(LEGACY_POSTING).highlights).toBeUndefined()
  })

  it("rejects highlights that are not strings", () => {
    expect(
      PostingSchema.safeParse({
        ...LEGACY_POSTING,
        highlights: [{ text: "5+ years in Go" }],
      }).success
    ).toBe(false)
  })

  it("describes highlights as copied, never composed", () => {
    const description = PostingSchema.shape.highlights.description ?? ""

    expect(description).toMatch(/word for word/i)
    expect(description).toMatch(/never compose/i)
    expect(description).toMatch(/summarise/i)
  })
})

describe("parseFindings", () => {
  it("still accepts findings whose postings carry no highlights", () => {
    const findings = parseFindings(
      JSON.stringify({ postings: [LEGACY_POSTING], notes: "One source only." })
    )

    expect(findings.postings).toHaveLength(1)
    expect(findings.postings[0]?.highlights).toBeUndefined()
  })

  it("carries highlights through to the writer", () => {
    const findings = parseFindings(
      JSON.stringify({
        postings: [
          { ...LEGACY_POSTING, highlights: ["On-call one week in six"] },
        ],
      })
    )

    expect(findings.postings[0]?.highlights).toEqual([
      "On-call one week in six",
    ])
  })
})

/**
 * The reported and the stored shape differ by one field, and everything else
 * about them is one definition. These assertions are what makes "add a field and
 * both halves get it" true rather than hoped for.
 */
describe("the two posting shapes", () => {
  const composed = [
    "title",
    "company",
    "location",
    "postedAt",
    "experience",
    "summary",
    "matchReason",
    "highlights",
  ]

  it("differ by exactly the field that names the posting", () => {
    const scout = Object.keys(ScoutPostingSchema.shape).sort()
    const stored = Object.keys(PostingSchema.shape).sort()

    expect(scout).toEqual([...composed, "id"].sort())
    expect(stored).toEqual([...composed, "url"].sort())
  })

  it("never shows the scout a URL, which is the point of the split", () => {
    // A URL the model cannot see is a URL it cannot mistype. The seven runs
    // lost to mistyping one are recorded in the worker's `resolve-postings.ts`.
    expect(ScoutPostingSchema.shape).not.toHaveProperty("url")
    expect(JSON.stringify(ScoutFindingsSchema.shape)).not.toMatch(/https?:/)
  })

  it("describes each composed field once, so the two cannot drift", () => {
    for (const field of composed) {
      const scout = ScoutPostingSchema.shape[field as "title"].description
      const stored = PostingSchema.shape[field as "title"].description

      expect(scout).toBe(stored)
      expect(scout).not.toBe("")
    }
  })

  it("tells the scout an id must be one a search returned", () => {
    const description = ScoutPostingSchema.shape.id.description ?? ""

    expect(description).toMatch(/a search returned/i)
    expect(description).toMatch(/dropped/i)
  })
})

/**
 * The prompt is no longer a second copy of the contract, and this is what says
 * so. It used to carry the whole schema rendered as JSON Schema, because the
 * hand-off was JSON in a message and nothing else would tell the model what to
 * write. `submit_findings` carries it now — the provider renders the tool's
 * arguments — so a prompt naming a field would be the drift the rendering
 * existed to prevent.
 */
describe("JOB_SCOUT_SYSTEM_PROMPT", () => {
  it("does not restate the findings schema", () => {
    const description = PostingSchema.shape.highlights.description ?? ""

    expect(description).not.toBe("")
    expect(JOB_SCOUT_SYSTEM_PROMPT).not.toContain(description)
    expect(JOB_SCOUT_SYSTEM_PROMPT).not.toContain("matchReason")
  })

  it("names the three passes and the tool that ends them", () => {
    expect(JOB_SCOUT_SYSTEM_PROMPT).toContain("get_posting_details")
    expect(JOB_SCOUT_SYSTEM_PROMPT).toContain("submit_findings")
  })
})
