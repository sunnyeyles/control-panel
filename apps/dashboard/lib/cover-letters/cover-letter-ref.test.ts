import { describe, expect, it } from "vitest"

import { coverLetterFilename, isPostingId } from "./cover-letter-ref"

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

describe("coverLetterFilename", () => {
  const POSTING_ID = "0f1e2d3c4b5a6978"

  it("names the file after the posting", () => {
    expect(
      coverLetterFilename({
        postingId: POSTING_ID,
        title: "Backend Engineer",
        company: "Acme",
      })
    ).toBe("Cover letter - Backend Engineer - Acme.md")
  })

  it("uses whichever half provenance recorded", () => {
    expect(
      coverLetterFilename({ postingId: POSTING_ID, title: "Backend Engineer" })
    ).toBe("Cover letter - Backend Engineer.md")

    expect(
      coverLetterFilename({ postingId: POSTING_ID, company: "Acme" })
    ).toBe("Cover letter - Acme.md")
  })

  it("falls back to the id when provenance recorded nothing usable", () => {
    // A letter drafted before provenance existed, or one whose head() failed.
    // The digest is a poor filename and a correct one.
    expect(coverLetterFilename({ postingId: POSTING_ID })).toBe(
      `Cover letter - ${POSTING_ID}.md`
    )
    expect(
      coverLetterFilename({ postingId: POSTING_ID, title: "   ", company: "" })
    ).toBe(`Cover letter - ${POSTING_ID}.md`)
  })

  it("keeps a path separator from suggesting a directory", () => {
    // The store already stripped these values to printable ASCII on the way in,
    // so a slash survives that and a filename is where it would matter.
    const name = coverLetterFilename({
      postingId: POSTING_ID,
      title: "Backend / Platform Engineer",
      company: "Acme\\Corp",
    })

    expect(name).not.toContain("/")
    expect(name).not.toContain("\\")
    expect(name).toBe("Cover letter - Backend Platform Engineer - Acme Corp.md")
  })

  it("drops the characters a filesystem refuses", () => {
    const name = coverLetterFilename({
      postingId: POSTING_ID,
      title: 'Engineer: "Senior"? <urgent> *now* |remote|',
    })

    for (const character of [":", '"', "?", "<", ">", "*", "|"]) {
      expect(name).not.toContain(character)
    }
  })

  it("bounds each half rather than the whole, so a long title cannot crowd out the company", () => {
    const name = coverLetterFilename({
      postingId: POSTING_ID,
      title: "E".repeat(200),
      company: "Acme",
    })

    expect(name.endsWith(" - Acme.md")).toBe(true)
    expect(name.length).toBeLessThan(120)
  })
})
