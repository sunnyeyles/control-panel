import { describe, expect, it } from "vitest"

import {
  EXTENSION_PATTERN,
  formatDocumentFile,
  parseDocumentFile,
  RESUME_ID_PATTERN,
} from "./document-ref"

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

describe("parseDocumentFile", () => {
  it("splits a well-formed segment into its two halves", () => {
    expect(parseDocumentFile(`${ID}.pdf`)).toEqual({
      resumeId: ID,
      extension: ".pdf",
    })
  })

  it("accepts what crypto.randomUUID actually produces", () => {
    // The pattern has to admit every id this app has ever written, or it turns
    // existing documents undownloadable.
    expect(parseDocumentFile(`${crypto.randomUUID()}.pdf`)).not.toBeUndefined()
  })

  it("rejects an id that is uuid-shaped only by length", () => {
    // 36 characters of `[0-9a-f-]`, and rejected by `assertSegment` in the
    // storage package for not starting alphanumeric. Caught here, where the
    // answer is a 404, rather than in the store, where it is a 500.
    expect(parseDocumentFile(`-aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`)).toBe(
      undefined
    )
  })

  it("rejects an id of the right length that is all dashes", () => {
    expect(parseDocumentFile(`${"-".repeat(36)}.pdf`)).toBe(undefined)
  })

  it("rejects a traversal attempt", () => {
    expect(parseDocumentFile("../../someone-else/resumes/theirs.pdf")).toBe(
      undefined
    )
  })

  it("rejects an id with no extension", () => {
    expect(parseDocumentFile(ID)).toBe(undefined)
  })

  it("rejects an uppercase extension", () => {
    // `extensionOf` lowercases before anything is stored, so a stored key never
    // has one — a request carrying one did not come from this app.
    expect(parseDocumentFile(`${ID}.PDF`)).toBe(undefined)
  })

  it("rejects a second extension", () => {
    // `cv.pdf.exe` cannot be a stored key: the id half is a single uuid.
    expect(parseDocumentFile(`${ID}.pdf.exe`)).toBe(undefined)
  })

  it("rejects trailing content after the extension", () => {
    expect(parseDocumentFile(`${ID}.pdf/../../etc/passwd`)).toBe(undefined)
  })
})

describe("formatDocumentFile", () => {
  it("round-trips through parseDocumentFile", () => {
    // The property that matters: the list page formats this string and the
    // download route parses it, and they used to do so from separate literals.
    const ref = { resumeId: ID, extension: ".pdf" }

    expect(parseDocumentFile(formatDocumentFile(ref))).toEqual(ref)
  })
})

describe("the exported halves", () => {
  it("match exactly what the composite accepts", () => {
    // The Zod schemas in `document-actions.ts` use these two directly, so a
    // delete and a download have to agree on which ids exist.
    expect(RESUME_ID_PATTERN.test(ID)).toBe(true)
    expect(RESUME_ID_PATTERN.test(`${ID}x`)).toBe(false)
    expect(EXTENSION_PATTERN.test(".pdf")).toBe(true)
    expect(EXTENSION_PATTERN.test("pdf")).toBe(false)
  })
})
