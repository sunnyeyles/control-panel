import { describe, expect, it } from "vitest"

import {
  assertDraftable,
  CoverLetterRequestSchema,
  MAX_BACKGROUND_CHARS,
  MIN_BACKGROUND_CHARS,
  toCoverLetterPrompt,
  UndraftableError,
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

/** A background of exactly `length` characters, with no leading whitespace. */
function background(length: number): string {
  return "a".repeat(length)
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

describe("assertDraftable", () => {
  it("accepts a background at the minimum", () => {
    expect(() =>
      assertDraftable({ background: background(MIN_BACKGROUND_CHARS) })
    ).not.toThrow()
  })

  it("accepts a background at the maximum", () => {
    expect(() =>
      assertDraftable({ background: background(MAX_BACKGROUND_CHARS) })
    ).not.toThrow()
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "  \n\t  "],
  ])("refuses a background that is %s", (_label, value) => {
    expect(() => assertDraftable({ background: value })).toThrow(
      UndraftableError
    )
    expect(() => assertDraftable({ background: value })).toThrow(
      /no candidate/i
    )
  })

  it("refuses a background under the minimum", () => {
    try {
      assertDraftable({ background: background(MIN_BACKGROUND_CHARS - 1) })
      expect.unreachable("a short background must be refused")
    } catch (error) {
      expect(error).toBeInstanceOf(UndraftableError)
      expect((error as UndraftableError).reason).toBe("too-short")
      expect((error as UndraftableError).length).toBe(MIN_BACKGROUND_CHARS - 1)
    }
  })

  it("refuses a background over the maximum rather than truncating it", () => {
    const oversized = background(MAX_BACKGROUND_CHARS + 1)

    try {
      assertDraftable({ background: oversized })
      expect.unreachable("an oversized background must be refused")
    } catch (error) {
      expect(error).toBeInstanceOf(UndraftableError)
      expect((error as UndraftableError).reason).toBe("too-long")
      // The refusal says why truncating is not the alternative, because
      // truncating is the obvious "fix" someone will reach for.
      expect((error as UndraftableError).message).toMatch(/truncat/i)
    }
  })

  it("measures the trimmed length, so padding cannot buy a pass", () => {
    const padded = `${" ".repeat(500)}${background(MIN_BACKGROUND_CHARS - 1)}${" ".repeat(500)}`

    expect(() => assertDraftable({ background: padded })).toThrow(
      UndraftableError
    )
  })

  /**
   * The distinction the type exists for: "you have uploaded nothing readable"
   * and "that document is too large" are different things to tell a user, and
   * matching on a message string is how that distinction rots.
   */
  it("distinguishes its three refusals", () => {
    const reasons = [
      undefined,
      background(10),
      background(MAX_BACKGROUND_CHARS + 1),
    ].map((value) => {
      try {
        assertDraftable({ background: value })
        return "drafted"
      } catch (error) {
        return (error as UndraftableError).reason
      }
    })

    expect(reasons).toEqual(["absent", "too-short", "too-long"])
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
