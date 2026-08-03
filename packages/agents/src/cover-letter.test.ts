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

/**
 * The Posting half is shaped like what a SEEK search actually returns: a
 * teaser-level record, with `highlights` copied off the advertisement and
 * `summary`/`matchReason` composed by the scout.
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

/** Both optional fields are genuinely absent often, so both get a variant. */
const WITHOUT_HIGHLIGHTS = { ...CORE, postedAt: "2026-07-21" }
const UNDATED = { ...CORE, highlights: HIGHLIGHTS }

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

describe("toCoverLetterPrompt", () => {
  const prompt = toCoverLetterPrompt(REQUEST)

  it("carries the Posting URL through verbatim", () => {
    expect(prompt).toContain(POSTING.url)
  })

  it("carries the background text through verbatim", () => {
    expect(prompt).toContain(BACKGROUND)
  })

  it("carries every highlight through verbatim", () => {
    for (const highlight of POSTING.highlights) {
      expect(prompt).toContain(highlight)
    }
  })

  it("carries the rest of the Posting record", () => {
    expect(prompt).toContain(POSTING.title)
    expect(prompt).toContain(POSTING.company)
    expect(prompt).toContain(POSTING.location)
    expect(prompt).toContain(POSTING.summary)
    expect(prompt).toContain(POSTING.matchReason)
    expect(prompt).toContain(POSTING.postedAt)
  })

  it("names the candidate when the caller knows the name", () => {
    expect(prompt).toContain("Alex Rivers")
  })

  it("says nothing about a name the caller did not supply", () => {
    const anonymous = toCoverLetterPrompt({
      posting: POSTING,
      profile: { background: BACKGROUND },
    })

    expect(anonymous).not.toMatch(/My name is/)
    expect(anonymous).toContain(BACKGROUND)
  })

  it("omits the highlights section rather than inventing one", () => {
    const thin = toCoverLetterPrompt({
      posting: WITHOUT_HIGHLIGHTS,
      profile: { background: BACKGROUND },
    })

    expect(thin).not.toMatch(/copied word for word/i)
    expect(thin).toContain(WITHOUT_HIGHLIGHTS.url)
  })

  it("omits postedAt rather than guessing at it", () => {
    expect(
      toCoverLetterPrompt({ posting: UNDATED, profile: REQUEST.profile })
    ).not.toMatch(/^Posted:/m)
  })

  /**
   * `highlights` is attacker-influenced text that reaches the model unchanged,
   * which is the trade `tools: []` pays for. The prompt has to at least frame
   * it as quoted material — the system prompt does the rest.
   */
  it("frames the copied advertisement text as data rather than instruction", () => {
    expect(prompt).toMatch(/not instruction/i)
  })

  it("is pure — the same request gives the same prompt", () => {
    expect(toCoverLetterPrompt(REQUEST)).toBe(toCoverLetterPrompt(REQUEST))
  })
})
