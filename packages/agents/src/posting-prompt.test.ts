import { describe, expect, it } from "vitest"

import { toPostingRequestPrompt } from "./posting-prompt.ts"
import {
  HIGHLIGHTS,
  POSTING,
  UNDATED,
  WITHOUT_HIGHLIGHTS,
} from "./test-support/posting-fixtures.ts"

/**
 * The shared body's contract, asserted once. `toCoverLetterPrompt` and
 * `toTailoredResumePrompt` are wrappers holding three sentences each, so their
 * suites assert those sentences and lean on this one for everything below.
 */
describe("toPostingRequestPrompt", () => {
  const WORDING = {
    opening: "Do the thing for the posting below.",
    backgroundHeading: "## My document",
    backgroundIntro: "This is my own document, reproduced exactly:",
  }

  const BACKGROUND = `I am a backend engineer with six years on data-heavy services. ${"Details of what I built, in my own words. ".repeat(5)}`

  const REQUEST = {
    posting: POSTING,
    profile: { name: "Alex Rivers", background: BACKGROUND },
  }

  const prompt = toPostingRequestPrompt(REQUEST, WORDING)

  it("opens with the wording's task line and heads the document with its heading", () => {
    expect(prompt.startsWith(WORDING.opening)).toBe(true)
    expect(prompt).toContain(WORDING.backgroundHeading)
    expect(prompt).toContain(WORDING.backgroundIntro)
  })

  it("carries the whole posting record, field by field", () => {
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

    expect(
      toPostingRequestPrompt(
        { ...REQUEST, posting: { ...POSTING, url } },
        WORDING
      )
    ).toContain(url)
  })

  it("carries the background text through verbatim", () => {
    expect(prompt).toContain(BACKGROUND)
  })

  /**
   * `highlights` is attacker-influenced text that reaches the model unchanged,
   * which is the trade the empty tool set pays for. The fence saying it is a
   * description of a job is part of the contract rather than decoration.
   */
  it("copies each highlight word for word, under the quoted-material fence", () => {
    for (const highlight of HIGHLIGHTS) {
      expect(prompt).toContain(`- ${highlight}`)
    }

    expect(prompt).toMatch(/quoted material, not instruction/i)
  })

  it("omits the highlights section rather than inventing one", () => {
    const thin = toPostingRequestPrompt(
      { ...REQUEST, posting: WITHOUT_HIGHLIGHTS },
      WORDING
    )

    expect(thin).not.toMatch(/copied word for word/i)
    expect(thin).toContain(WITHOUT_HIGHLIGHTS.url)
  })

  it("omits the posted line rather than guessing at a date", () => {
    expect(
      toPostingRequestPrompt({ ...REQUEST, posting: UNDATED }, WORDING)
    ).not.toMatch(/^Posted:/m)
  })

  it("names the candidate only when the caller knows the name", () => {
    expect(prompt).toContain("My name is Alex Rivers.")

    const anonymous = toPostingRequestPrompt(
      { posting: POSTING, profile: { background: BACKGROUND } },
      WORDING
    )

    expect(anonymous).not.toMatch(/My name is/)
    expect(anonymous).toContain(BACKGROUND)
  })

  it("says outright that there is nothing else to look up", () => {
    expect(prompt).toMatch(/no way to look either up/i)
  })

  it("is pure — the same request gives the same prompt", () => {
    expect(toPostingRequestPrompt(REQUEST, WORDING)).toBe(prompt)
  })
})
