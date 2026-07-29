import { describe, expect, it } from "vitest"

import {
  checkUpload,
  describeRejection,
  extensionOf,
  MAX_DOCUMENT_BYTES,
  MAX_REQUEST_BYTES,
} from "./upload-validation"

/** The real allowlist, restated so this file imports nothing. */
const ACCEPTED = [".pdf", ".doc", ".docx", ".odt", ".rtf", ".txt", ".md"]

const ok = { filename: "cv.pdf", byteLength: 1024 }

describe("extensionOf", () => {
  it("lowercases, so a shouted filename is not a different file type", () => {
    expect(extensionOf("CV.PDF")).toBe(".pdf")
  })

  it("takes the last dot, so a double extension cannot hide behind the first", () => {
    // The oldest trick against a filter that stops at the first dot: the file
    // is an .exe and reads as a .pdf.
    expect(extensionOf("cv.pdf.exe")).toBe(".exe")
  })

  it("has none for a name with no dot", () => {
    expect(extensionOf("README")).toBeUndefined()
  })

  it("has none for a name ending in a dot", () => {
    expect(extensionOf("cv.")).toBeUndefined()
  })

  it("has none for a name that is only an extension", () => {
    // No basename. Far more likely a dotfile or a mangled upload than a
    // document someone meant to send.
    expect(extensionOf(".pdf")).toBeUndefined()
  })

  it("ignores surrounding whitespace", () => {
    expect(extensionOf("  cv.pdf  ")).toBe(".pdf")
  })

  it("survives a name that is mostly dots", () => {
    expect(extensionOf("...pdf")).toBe(".pdf")
  })

  it("handles a very long name without truncating the extension", () => {
    expect(extensionOf(`${"a".repeat(300)}.pdf`)).toBe(".pdf")
  })
})

describe("checkUpload", () => {
  it("accepts a normal document and reports its extension", () => {
    const result = checkUpload(ok, ACCEPTED)

    expect(result.ok).toBe(true)
    expect(result.ok && result.extension).toBe(".pdf")
  })

  it("accepts an uppercase extension as its lowercase form", () => {
    // The extension is handed to the storage layer, whose allowlist is
    // lowercase. Passing `.PDF` through would fail there instead of here.
    const result = checkUpload({ ...ok, filename: "CV.PDF" }, ACCEPTED)

    expect(result.ok && result.extension).toBe(".pdf")
  })

  it("rejects an empty filename", () => {
    const result = checkUpload({ ...ok, filename: "   " }, ACCEPTED)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.rejection.reason).toBe("empty-filename")
  })

  it("rejects a name with no extension", () => {
    const result = checkUpload({ ...ok, filename: "README" }, ACCEPTED)

    expect(!result.ok && result.rejection.reason).toBe("no-extension")
  })

  it("rejects an extension that is not on the allowlist", () => {
    const result = checkUpload({ ...ok, filename: "resume.html" }, ACCEPTED)

    expect(!result.ok && result.rejection.reason).toBe("unsupported-extension")
  })

  it("rejects a double extension on its real ending", () => {
    const result = checkUpload({ ...ok, filename: "cv.pdf.exe" }, ACCEPTED)

    expect(!result.ok && result.rejection.reason).toBe("unsupported-extension")
    expect(
      !result.ok &&
        result.rejection.reason === "unsupported-extension" &&
        result.rejection.extension
    ).toBe(".exe")
  })

  it("rejects an empty file before complaining about its size", () => {
    const result = checkUpload({ ...ok, byteLength: 0 }, ACCEPTED)

    expect(!result.ok && result.rejection.reason).toBe("empty-file")
  })

  it("accepts a file of exactly the limit", () => {
    const result = checkUpload(
      { ...ok, byteLength: MAX_DOCUMENT_BYTES },
      ACCEPTED
    )

    expect(result.ok).toBe(true)
  })

  it("rejects a file one byte over the limit", () => {
    const result = checkUpload(
      { ...ok, byteLength: MAX_DOCUMENT_BYTES + 1 },
      ACCEPTED
    )

    expect(!result.ok && result.rejection.reason).toBe("too-large")
  })

  it("checks the extension before the size, so the more useful complaint wins", () => {
    // A 50 MB .exe is wrong in two ways. Being told the type is unsupported is
    // actionable; being told to compress it is not.
    const result = checkUpload(
      { filename: "virus.exe", byteLength: 50 * 1024 * 1024 },
      ACCEPTED
    )

    expect(!result.ok && result.rejection.reason).toBe("unsupported-extension")
  })

  it("accepts a 300-character name, since the name is never a key segment", () => {
    const result = checkUpload(
      { ...ok, filename: `${"a".repeat(300)}.pdf` },
      ACCEPTED
    )

    expect(result.ok).toBe(true)
  })
})

describe("the limit ladder", () => {
  it("keeps the request ceiling above the document ceiling", () => {
    // A multipart body carries boundaries and headers around the file, so a
    // document at exactly the document limit must still fit inside the request
    // limit — otherwise the honest-witness check would reject uploads the
    // authoritative check would have allowed.
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(MAX_DOCUMENT_BYTES)
  })

  it("leaves both under Vercel's ~4.5 MB platform cap", () => {
    // Enforced before the request reaches Next, so exceeding it produces a
    // platform 413 that no code in this repo can turn into a friendly message.
    expect(MAX_REQUEST_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })
})

describe("describeRejection", () => {
  it("names the accepted types when the extension is wrong", () => {
    const message = describeRejection({
      reason: "unsupported-extension",
      extension: ".html",
      accepted: ACCEPTED,
    })

    expect(message).toContain(".html")
    expect(message).toContain(".pdf")
    expect(message).toContain(".md")
  })

  it("gives both the actual size and the limit when a file is too large", () => {
    // "Too large" without a number leaves the user guessing how much to cut.
    const message = describeRejection({
      reason: "too-large",
      byteLength: 5 * 1024 * 1024,
    })

    expect(message).toContain("5.0 MB")
    expect(message).toContain("3.0 MB")
  })

  it("says something for every rejection reason", () => {
    const rejections = [
      { reason: "empty-filename" },
      { reason: "no-extension", filename: "README" },
      { reason: "unsupported-extension", extension: ".x", accepted: ACCEPTED },
      { reason: "empty-file" },
      { reason: "too-large", byteLength: 9_000_000 },
    ] as const

    for (const rejection of rejections) {
      expect(describeRejection(rejection).length).toBeGreaterThan(0)
    }
  })
})
