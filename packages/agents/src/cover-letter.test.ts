import { describe, expect, it } from "vitest"

import {
  CoverLetterRequestSchema,
  toCoverLetterPrompt,
  type CoverLetterRequest,
} from "./cover-letter.ts"
import { POSTING, WITHOUT_HIGHLIGHTS } from "./test-support/posting-fixtures.ts"

const BACKGROUND = `I am a backend engineer with six years on data-heavy services. ${"Details of what I built, in my own words. ".repeat(
  5
)}`

const REQUEST: CoverLetterRequest = {
  posting: POSTING,
  profile: { name: "Alex Rivers", background: BACKGROUND },
}

/**
 * `TailoredResumeRequestSchema` is this same object under the other feature's
 * name, so this suite is the request shape's one home.
 */
describe("CoverLetterRequestSchema", () => {
  it("parses a request whose Posting carries no highlights", () => {
    const result = CoverLetterRequestSchema.safeParse({
      posting: WITHOUT_HIGHLIGHTS,
      profile: { background: BACKGROUND },
    })

    expect(result.success).toBe(true)
    expect(result.data?.posting.highlights).toBeUndefined()
    expect(result.data?.profile.name).toBeUndefined()
  })

  it("rejects a Posting whose url is not a URL", () => {
    expect(
      CoverLetterRequestSchema.safeParse({
        posting: { ...POSTING, url: "seek, the one with the pipelines" },
        profile: { background: BACKGROUND },
      }).success
    ).toBe(false)
  })

  it("requires a background, since it is the document being worked from", () => {
    expect(
      CoverLetterRequestSchema.safeParse({
        posting: POSTING,
        profile: { name: "Alex Rivers" },
      }).success
    ).toBe(false)
  })
})

/**
 * The body — verbatim carry-through, the quoted-material fence, the omitted
 * sections — is `toPostingRequestPrompt`'s contract, asserted once in
 * `posting-prompt.test.ts`. What this wrapper owns is its three sentences.
 */
describe("toCoverLetterPrompt", () => {
  const prompt = toCoverLetterPrompt(REQUEST)

  it("opens by asking for a cover letter", () => {
    expect(
      prompt.startsWith("Write my cover letter for the posting below.")
    ).toBe(true)
  })

  it("introduces the background as the source every claim must trace to", () => {
    expect(prompt).toContain("## My background")
    expect(prompt).toMatch(/traceable to it/i)
  })

  it("carries the posting and the background through the shared body", () => {
    expect(prompt).toContain(POSTING.url)
    expect(prompt).toContain(BACKGROUND)
  })
})
