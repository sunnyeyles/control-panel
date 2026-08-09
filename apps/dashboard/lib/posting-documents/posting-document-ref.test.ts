import { describe, expect, it } from "vitest"

import { isPostingId } from "./posting-document-ref"

describe("isPostingId", () => {
  it("accepts what postingId() produces", () => {
    expect(isPostingId("0f1e2d3c4b5a6978")).toBe(true)
  })

  it("refuses anything that could not be a key segment", () => {
    for (const bad of [
      "../../etc/passwd",
      "0f1e2d3c/4b5a6978",
      "0F1E2D3C4B5A6978",
      "0f1e2d3c4b5a697",
      "0f1e2d3c4b5a69789",
      "11111111-2222-4333-8444-555555555555",
      "",
      "  0f1e2d3c4b5a6978",
    ]) {
      expect(isPostingId(bad)).toBe(false)
    }
  })

  it("refuses a value that is not a string at all", () => {
    // Reachable despite the types: this predicate guards values crossing a form
    // or a URL boundary, where `null` is what an absent field looks like.
    expect(isPostingId(null)).toBe(false)
    expect(isPostingId(undefined)).toBe(false)
    expect(isPostingId(42)).toBe(false)
  })
})
