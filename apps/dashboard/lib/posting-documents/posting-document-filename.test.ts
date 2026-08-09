/**
 * The naming rule, tested once against the label both kinds pass in.
 *
 * These assertions used to sit in `cover-letter-ref.test.ts` and were about to
 * be copied into a resume counterpart — the character cleaning is the part
 * worth having one copy of, so it is the part tested here. What each feature
 * still owns is its *label*, and that is all its own suite checks.
 */

import { describe, expect, it } from "vitest"

import { postingDocumentFilename } from "./posting-document-filename"

const POSTING_ID = "0f1e2d3c4b5a6978"

function name(parts: { title?: string; company?: string }): string {
  return postingDocumentFilename("Cover letter", {
    postingId: POSTING_ID,
    ...parts,
  })
}

describe("postingDocumentFilename", () => {
  it("names the file after the posting", () => {
    expect(name({ title: "Backend Engineer", company: "Acme" })).toBe(
      "Cover letter - Backend Engineer - Acme.md"
    )
  })

  it("uses whichever half provenance recorded", () => {
    expect(name({ title: "Backend Engineer" })).toBe(
      "Cover letter - Backend Engineer.md"
    )
    expect(name({ company: "Acme" })).toBe("Cover letter - Acme.md")
  })

  it("falls back to the id when provenance recorded nothing usable", () => {
    // A document written before provenance existed, or one whose head() failed.
    // The digest is a poor filename and a correct one.
    expect(name({})).toBe(`Cover letter - ${POSTING_ID}.md`)
    expect(name({ title: "   ", company: "" })).toBe(
      `Cover letter - ${POSTING_ID}.md`
    )
  })

  it("keeps a path separator from suggesting a directory", () => {
    // The store already stripped these values to printable ASCII on the way in,
    // so a slash survives that and a filename is where it would matter.
    const filename = name({
      title: "Backend / Platform Engineer",
      company: "Acme\\Corp",
    })

    expect(filename).not.toContain("/")
    expect(filename).not.toContain("\\")
    expect(filename).toBe(
      "Cover letter - Backend Platform Engineer - Acme Corp.md"
    )
  })

  it("drops the characters a filesystem refuses", () => {
    const filename = name({
      title: 'Engineer: "Senior"? <urgent> *now* |remote|',
    })

    for (const character of [":", '"', "?", "<", ">", "*", "|"]) {
      expect(filename).not.toContain(character)
    }
  })

  it("bounds each half rather than the whole, so a long title cannot crowd out the company", () => {
    const filename = name({ title: "E".repeat(200), company: "Acme" })

    expect(filename.endsWith(" - Acme.md")).toBe(true)
    expect(filename.length).toBeLessThan(120)
  })

  it("carries the label through, which is all the two kinds differ by", () => {
    const parts = { postingId: POSTING_ID, title: "Backend Engineer" }

    expect(postingDocumentFilename("Cover letter", parts)).toBe(
      "Cover letter - Backend Engineer.md"
    )
    expect(postingDocumentFilename("Tailored resume", parts)).toBe(
      "Tailored resume - Backend Engineer.md"
    )
  })
})
