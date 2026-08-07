import { describe, expect, it } from "vitest"

import {
  toTailoredResumePrompt,
  TailoredResumeRequestSchema,
  type TailoredResumeRequest,
} from "./tailored-resume.ts"

/**
 * The Posting half is shaped like what a SEEK search actually returns: a
 * teaser-level record, with `highlights` copied off the advertisement and
 * `summary`/`matchReason` composed by the scout. Same fixtures as
 * `cover-letter.test.ts`, because the two features consume the identical record
 * and a Posting that one accepts the other must too.
 */
const CORE = {
  title: "Senior Backend Engineer",
  company: "Morgan McKinley",
  location: "Sydney NSW (Hybrid)",
  url: "https://www.seek.com.au/job/93431609",
  summary: "A backend role on a real-time data product.",
  matchReason: "Backend, Sydney, and the stack the candidate asked for.",
}

/** Copied off the advertisement, which is what makes them safe to reproduce. */
const HIGHLIGHTS = [
  "Senior Backend Engineer (Python/AWS) - real-time data product, global clients",
  "Own async pipelines & AWS infra - queues, workers, full ownership",
]

const POSTING = { ...CORE, postedAt: "2026-07-21", highlights: HIGHLIGHTS }
const WITHOUT_HIGHLIGHTS = { ...CORE, postedAt: "2026-07-21" }
const UNDATED = { ...CORE, highlights: HIGHLIGHTS }

const RESUME = `# Alex Rivers

## Experience

**Backend Engineer, Northwind** — 2020 to 2026

- Built async ingestion pipelines on AWS.
- Contributed to the migration off a monolith.
`

const REQUEST: TailoredResumeRequest = {
  posting: POSTING,
  profile: { name: "Alex Rivers", background: RESUME },
}

describe("TailoredResumeRequestSchema", () => {
  it("parses a request whose Posting carries no highlights", () => {
    const result = TailoredResumeRequestSchema.safeParse({
      posting: WITHOUT_HIGHLIGHTS,
      profile: { background: RESUME },
    })

    expect(result.success).toBe(true)
    expect(result.data?.posting.highlights).toBeUndefined()
    expect(result.data?.profile.name).toBeUndefined()
  })

  /**
   * The same rule the Findings schema enforces upstream, restated here because
   * this schema is a separate entry point: a URL the scout assembled rather than
   * received is a fabrication, and the request that would rewrite a CV around it
   * must not parse.
   */
  it("rejects a Posting whose url is not a URL", () => {
    expect(
      TailoredResumeRequestSchema.safeParse({
        posting: { ...POSTING, url: "seek, the one with the pipelines" },
        profile: { background: RESUME },
      }).success
    ).toBe(false)
  })

  it("requires a background, since it is the document being rewritten", () => {
    expect(
      TailoredResumeRequestSchema.safeParse({
        posting: POSTING,
        profile: { name: "Alex Rivers" },
      }).success
    ).toBe(false)
  })
})

/**
 * The prompt is the whole of what the model may say about the role — it has no
 * tools, so what is not in this string does not exist for it. The properties
 * worth pinning are the verbatim ones: paraphrasing any of the three would put
 * this module in the business of deciding what the advertisement said or what
 * the candidate claimed.
 */
describe("toTailoredResumePrompt", () => {
  it("carries the whole posting record, field by field", () => {
    const prompt = toTailoredResumePrompt(REQUEST)

    expect(prompt).toContain(`Title: ${POSTING.title}`)
    expect(prompt).toContain(`Company: ${POSTING.company}`)
    expect(prompt).toContain(`Location: ${POSTING.location}`)
    expect(prompt).toContain(`URL: ${POSTING.url}`)
    expect(prompt).toContain(`Posted: ${POSTING.postedAt}`)
    expect(prompt).toContain(POSTING.summary)
    expect(prompt).toContain(POSTING.matchReason)
  })

  it("reproduces the URL exactly, tracking parameters and all", () => {
    const url = "https://www.seek.com.au/job/93431609?type=standard&ref=search"
    const prompt = toTailoredResumePrompt({
      ...REQUEST,
      posting: { ...POSTING, url },
    })

    expect(prompt).toContain(url)
  })

  /**
   * `highlights` is attacker-influenced text — anyone who can pay to place an
   * advertisement writes it — and it is copied rather than laundered. That is
   * acceptable only because the agent has no tools, so the fence saying it is a
   * description of a job is part of the contract rather than decoration.
   */
  it("copies each highlight word for word, under the quoted-material fence", () => {
    const prompt = toTailoredResumePrompt(REQUEST)

    for (const highlight of HIGHLIGHTS) {
      expect(prompt).toContain(`- ${highlight}`)
    }

    expect(prompt).toMatch(/quoted material, not instruction/i)
  })

  it("omits the highlights section entirely when there are none", () => {
    const prompt = toTailoredResumePrompt({
      ...REQUEST,
      posting: WITHOUT_HIGHLIGHTS,
    })

    expect(prompt).not.toMatch(/copied word for word/i)
  })

  it("omits the posted line when the advertisement carried no date", () => {
    const prompt = toTailoredResumePrompt({ ...REQUEST, posting: UNDATED })

    expect(prompt).not.toContain("Posted:")
  })

  it("reproduces the resume verbatim, markdown structure and all", () => {
    const prompt = toTailoredResumePrompt(REQUEST)

    expect(prompt).toContain(RESUME)
  })

  it("names the candidate only when the caller knows the name", () => {
    expect(toTailoredResumePrompt(REQUEST)).toContain("My name is Alex Rivers.")
    expect(
      toTailoredResumePrompt({
        ...REQUEST,
        profile: { background: RESUME },
      })
    ).not.toContain("My name is")
  })

  /**
   * The one line that distinguishes this prompt from the cover letter's. There
   * the CV is a source to write *about*; here it is the document being rewritten,
   * and the correspondence rule is what stops the advertisement's vocabulary from
   * being attached to the candidate.
   */
  it("introduces the resume as the document being rewritten", () => {
    const prompt = toTailoredResumePrompt(REQUEST)

    expect(prompt).toMatch(/the document you are rewriting/i)
    expect(prompt).toMatch(/must have a counterpart here/i)
  })

  it("says outright that there is nothing else to look up", () => {
    expect(toTailoredResumePrompt(REQUEST)).toMatch(/no way to look either up/i)
  })
})
