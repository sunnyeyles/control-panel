import { describe, expect, it } from "vitest"

import { CoverLetterRequestSchema } from "./cover-letter.ts"
import {
  TailoredResumeRequestSchema,
  toTailoredResumePrompt,
  type TailoredResumeRequest,
} from "./tailored-resume.ts"
import { POSTING } from "./test-support/posting-fixtures.ts"

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

/**
 * One schema object under two names, so a Posting the letter accepts the
 * rewrite must too. The shape's tests live in `cover-letter.test.ts`; what
 * this asserts is that there is nothing separate here to drift.
 */
describe("TailoredResumeRequestSchema", () => {
  it("is the cover-letter request schema, not a restatement of it", () => {
    expect(TailoredResumeRequestSchema).toBe(CoverLetterRequestSchema)
  })
})

/**
 * The body — verbatim carry-through, the quoted-material fence, the omitted
 * sections — is `toPostingRequestPrompt`'s contract, asserted once in
 * `posting-prompt.test.ts`. What this wrapper owns is its three sentences, and
 * they are the whole difference between the two features.
 */
describe("toTailoredResumePrompt", () => {
  const prompt = toTailoredResumePrompt(REQUEST)

  it("opens by asking for a rewrite", () => {
    expect(prompt.startsWith("Rewrite my resume for the posting below.")).toBe(
      true
    )
  })

  /**
   * There the CV is a source to write *about*; here it is the document being
   * rewritten, and the correspondence rule is what stops the advertisement's
   * vocabulary from being attached to the candidate.
   */
  it("introduces the resume as the document being rewritten", () => {
    expect(prompt).toContain("## My resume")
    expect(prompt).toMatch(/the document you are rewriting/i)
    expect(prompt).toMatch(/must have a counterpart here/i)
  })

  it("carries the posting and the resume through the shared body", () => {
    expect(prompt).toContain(POSTING.url)
    expect(prompt).toContain(RESUME)
  })
})
