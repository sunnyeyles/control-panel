import { describe, expect, it } from "vitest"

import { contentDisposition } from "./content-disposition"

/** The `filename*=UTF-8''…` value, which is the half browsers actually use. */
function extValue(header: string): string {
  return header.split("filename*=UTF-8''")[1] ?? ""
}

/** The contents of `filename="…"`, escapes and all. */
function quoted(header: string): string {
  return /filename="((?:[^"\\]|\\.)*)"/.exec(header)?.[1] ?? ""
}

describe("contentDisposition", () => {
  it("is an attachment, always", () => {
    // The stored-XSS guard. These bytes arrived from outside, and a browser
    // that renders one inline on this origin runs it with the session cookie
    // attached.
    expect(contentDisposition("cv.pdf")).toMatch(/^attachment;/)
  })

  it("emits both forms for an ordinary name", () => {
    expect(contentDisposition("cv.pdf")).toBe(
      `attachment; filename="cv.pdf"; filename*=UTF-8''cv.pdf`
    )
  })

  it("escapes a quote rather than letting it close the string early", () => {
    // The one that matters. Unescaped, everything after the quote is read as
    // further header parameters.
    const header = contentDisposition('my "good" cv.pdf')

    expect(quoted(header)).toBe('my \\"good\\" cv.pdf')
  })

  it("escapes a backslash, so an escape cannot be forged", () => {
    // Without this, a filename ending in a backslash escapes the closing quote.
    const header = contentDisposition("back\\slash.pdf")

    expect(quoted(header)).toBe("back\\\\slash.pdf")
  })

  it("escapes a trailing backslash, which would otherwise eat the closing quote", () => {
    const header = contentDisposition("trailing\\")

    expect(header).toContain('filename="trailing\\\\"')
  })

  it("percent-encodes the apostrophe, which delimits the ext-value", () => {
    // `encodeURIComponent` leaves `'` alone because it is legal in a URI
    // component. It is not an attr-char, and it is the field's own separator,
    // so an unencoded one puts three apostrophes where the grammar allows two.
    const header = contentDisposition("Alice's CV.pdf")

    expect(extValue(header)).toBe("Alice%27s%20CV.pdf")
    expect(extValue(header)).not.toContain("'")
  })

  it("percent-encodes the other characters encodeURIComponent leaves behind", () => {
    // !()* are all legal in a URI component and none is an attr-char.
    const header = contentDisposition("cv!(final)*.pdf")

    expect(extValue(header)).toBe("cv%21%28final%29%2A.pdf")
  })

  it("percent-encodes a space rather than emitting a bare one", () => {
    // A raw space would end the parameter and make the rest of the name look
    // like another one.
    expect(extValue(contentDisposition("my cv.pdf"))).toBe("my%20cv.pdf")
  })

  it("leaves attr-chars alone, so the common case stays readable", () => {
    expect(extValue(contentDisposition("cv-2026_final.v2.pdf"))).toBe(
      "cv-2026_final.v2.pdf"
    )
  })

  it("carries a non-ASCII name through the ext-value", () => {
    // `cleanFilename` strips these at write time, so nothing stored today
    // reaches here — which is exactly why it is worth pinning: the quoted form
    // cannot represent them and the ext-value is the reason both are emitted.
    const header = contentDisposition("café.pdf")

    expect(extValue(header)).toBe("caf%C3%A9.pdf")
  })

  it("has no CR or LF in its output, whatever goes in", () => {
    // Header injection, the reason `cleanFilename` strips these upstream. That
    // guard is on the write path in another package; this function has to hold
    // on its own, because it is what turns a string into a header.
    const header = contentDisposition("evil\r\nSet-Cookie: a=b.pdf")

    expect(header).not.toMatch(/[\r\n]/)
    expect(header).toContain('filename="evilSet-Cookie: a=b.pdf"')
  })

  it("strips every control character, not only the newlines", () => {
    const header = contentDisposition("a\x00b\x01c\x1Fd\x7Fe.pdf")

    expect(quoted(header)).toBe("abcde.pdf")
  })

  it("strips controls before escaping, so no half-escape survives", () => {
    // Escaping first would turn the backslash into `\\` and then remove the
    // newline between them, leaving a stray pair.
    const header = contentDisposition("a\\\nb.pdf")

    expect(quoted(header)).toBe("a\\\\b.pdf")
  })

  it("handles the id fallback the route passes when there is no stored name", () => {
    const header = contentDisposition("aaaaaaaa-bbbb-4ccc-8ddd-ee.pdf")

    expect(header).toBe(
      `attachment; filename="aaaaaaaa-bbbb-4ccc-8ddd-ee.pdf"; ` +
        `filename*=UTF-8''aaaaaaaa-bbbb-4ccc-8ddd-ee.pdf`
    )
  })
})
