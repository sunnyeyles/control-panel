/**
 * The label, which is the whole of what this module adds.
 *
 * Everything else a filename has to get right — the character cleaning, the
 * fallback to the id, the per-half length bound — belongs to
 * `posting-document-filename.test.ts`, because a tailored resume needs the
 * identical behaviour and a second copy of these assertions is how the two
 * would come to disagree.
 */

import { describe, expect, it } from "vitest"

import { coverLetterFilename } from "./cover-letter-ref"

describe("coverLetterFilename", () => {
  it("says what kind of document the download is", () => {
    // "Cover letter", not "Letter": it lands in a folder beside whatever else
    // the user has downloaded, and has to be identifiable there.
    expect(
      coverLetterFilename({
        postingId: "0f1e2d3c4b5a6978",
        title: "Backend Engineer",
        company: "Acme",
      })
    ).toBe("Cover letter - Backend Engineer - Acme.md")
  })
})
