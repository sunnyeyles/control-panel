import { describe, expect, it } from "vitest"

import {
  FindingsSchema,
  jobScoutSchemaDescription,
  parseFindings,
  PostingSchema,
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
 * The point of `jobScoutSchemaDescription` is that the scout's prompt is not a
 * second copy of the contract. These assertions are what makes "add a field and
 * the scout asks for it" true rather than hoped for — nothing below names
 * `highlights` in a prompt string, and yet the prompt asks for it.
 */
describe("jobScoutSchemaDescription", () => {
  it("is derived from the schema, so a new field needs no prompt edit", () => {
    const rendered = JSON.parse(jobScoutSchemaDescription) as {
      properties: {
        postings: { items: { properties: Record<string, { type?: string }> } }
      }
    }

    const posting = rendered.properties.postings.items.properties

    expect(Object.keys(posting).sort()).toEqual(
      Object.keys(FindingsSchema.shape.postings.element.shape).sort()
    )
    expect(posting.highlights?.type).toBe("array")
  })

  it("carries each field's description into the scout's prompt verbatim", () => {
    const description = PostingSchema.shape.highlights.description ?? ""

    expect(description).not.toBe("")
    expect(jobScoutSchemaDescription).toContain(description)
    expect(JOB_SCOUT_SYSTEM_PROMPT).toContain(description)
  })

  it("marks highlights optional, so the scout may omit it honestly", () => {
    const rendered = JSON.parse(jobScoutSchemaDescription) as {
      properties: {
        postings: { items: { required?: string[] } }
      }
    }

    expect(rendered.properties.postings.items.required).not.toContain(
      "highlights"
    )
    expect(rendered.properties.postings.items.required).toContain("url")
  })
})
