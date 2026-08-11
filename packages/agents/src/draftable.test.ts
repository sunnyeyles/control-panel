import { describe, expect, it } from "vitest"

import {
  assertDraftable,
  MAX_BACKGROUND_CHARS,
  MIN_BACKGROUND_CHARS,
  UndraftableError,
} from "./draftable.ts"

/** A background of exactly `length` characters, with no leading whitespace. */
function background(length: number): string {
  return "a".repeat(length)
}

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
