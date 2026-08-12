import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import {
  extractProfileText,
  isReadableProfileExtension,
  ProfileTextError,
  READABLE_PROFILE_EXTENSIONS,
} from "./profile-text"

/**
 * The parsers, against files a real program actually wrote.
 *
 * ⚠️ **`__fixtures__/` holds genuine binaries, and that is the entire point of
 * this file.** `alice-cv.pdf` and `thin-cv.pdf` came out of `cupsfilter` — a
 * real PDF with embedded font subsets, an xref table and a compressed content
 * stream, not a hand-written string that happens to start `%PDF-`.
 * `alice-cv.docx` came out of `textutil -convert docx`, so it is real OOXML in a
 * real zip.
 *
 * A mocked `unpdf` or `mammoth` would assert that this module passes bytes to a
 * function and returns what it gets back. The claim #86 makes is that a PDF CV
 * can be drafted from, and only a real PDF supports it.
 *
 * The fixtures are small and boring on purpose, so a diff to them is legible.
 */

/** What both CV fixtures say, in the words they say it. */
const CV_SENTENCES = [
  "Alice Example",
  "Backend Engineer, Sydney",
  "Built and ran payment",
  "monolith to a set of services at Contoso",
  "Terraform and AWS",
  "Looking for backend work with some infrastructure in it.",
]

function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(`./__fixtures__/${name}`, import.meta.url))
}

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fixture(name))
}

describe("READABLE_PROFILE_EXTENSIONS", () => {
  it("covers the four formats with a parser and no others", () => {
    expect([...READABLE_PROFILE_EXTENSIONS]).toEqual([
      ".md",
      ".txt",
      ".pdf",
      ".docx",
    ])
  })

  it("still excludes the three the resumes kind accepts without a parser", () => {
    // `.doc`, `.odt` and `.rtf` upload fine and are refused by name at drafting
    // time. If a parser is ever added for one of them, this line is what fails
    // and points at the message that has to change with it.
    for (const extension of [".doc", ".odt", ".rtf"]) {
      expect(isReadableProfileExtension(extension)).toBe(false)
    }
  })
})

describe("extractProfileText", () => {
  describe("a real PDF", () => {
    it("returns the text a PDF writer put in it", async () => {
      const text = await extractProfileText(
        ".pdf",
        await fixtureBytes("alice-cv.pdf")
      )

      for (const sentence of CV_SENTENCES) expect(text).toContain(sentence)
    })

    it("does not detach the caller's buffer", async () => {
      // ⚠️ pdf.js *transfers* the array it is handed: without the copy in
      // `extractPdfText` this read throws `TypedArray.prototype.slice on a
      // detached ArrayBuffer`, and it would do so in whatever unrelated code
      // touched the bytes next.
      const bytes = await fixtureBytes("alice-cv.pdf")

      await extractProfileText(".pdf", bytes)

      expect(() => bytes.slice(0, 8)).not.toThrow()
      expect(bytes.byteLength).toBeGreaterThan(0)
    })
  })

  describe("a real DOCX", () => {
    it("returns the text a word processor put in it", async () => {
      const text = await extractProfileText(
        ".docx",
        await fixtureBytes("alice-cv.docx")
      )

      for (const sentence of CV_SENTENCES) expect(text).toContain(sentence)
    })
  })

  describe("text formats", () => {
    it("decodes .md and .txt without touching them", async () => {
      const source = "# Alice\n\nEngineer.\n\tTabbed.  Double  spaced.\n"
      const bytes = new TextEncoder().encode(source)

      expect(await extractProfileText(".md", bytes)).toBe(source)
      expect(await extractProfileText(".txt", bytes)).toBe(source)
    })
  })

  describe("when the file cannot be read", () => {
    /**
     * Each of these is a way a real upload goes wrong, and every one of them
     * has to arrive as a {@link ProfileTextError} rather than as a crash or as
     * a partial string. A parser that returned what it managed to read would
     * put a letter's worth of invented specifics in the user's name.
     */
    it("refuses a truncated PDF", async () => {
      const whole = await fixture("alice-cv.pdf")
      const half = new Uint8Array(
        whole.subarray(0, Math.floor(whole.length / 2))
      )

      await expect(extractProfileText(".pdf", half)).rejects.toBeInstanceOf(
        ProfileTextError
      )
    })

    it("refuses a text file renamed .pdf", async () => {
      const bytes = new TextEncoder().encode(
        "Alice Example\nBackend Engineer\n".repeat(20)
      )

      await expect(extractProfileText(".pdf", bytes)).rejects.toBeInstanceOf(
        ProfileTextError
      )
    })

    it("refuses an empty .pdf", async () => {
      await expect(
        extractProfileText(".pdf", new Uint8Array(0))
      ).rejects.toBeInstanceOf(ProfileTextError)
    })

    it("refuses a PDF renamed .docx", async () => {
      // A DOCX is a zip; a PDF is not one, and jszip says so loudly.
      await expect(
        extractProfileText(".docx", await fixtureBytes("alice-cv.pdf"))
      ).rejects.toBeInstanceOf(ProfileTextError)
    })

    it("refuses a truncated DOCX", async () => {
      const whole = await fixture("alice-cv.docx")
      const half = new Uint8Array(
        whole.subarray(0, Math.floor(whole.length / 2))
      )

      await expect(extractProfileText(".docx", half)).rejects.toBeInstanceOf(
        ProfileTextError
      )
    })

    it("keeps the parser's own error on `cause` and out of the message", async () => {
      // The message is shown to a person; pdf.js talks about xref tables.
      const error = await extractProfileText(".pdf", new Uint8Array(0)).catch(
        (thrown: unknown) => thrown
      )

      expect(error).toBeInstanceOf(ProfileTextError)
      expect((error as ProfileTextError).message).toBe(
        "that PDF could not be read"
      )
      expect((error as ProfileTextError).cause).toBeDefined()
    })
  })
})
