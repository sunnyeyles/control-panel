/**
 * Turning an uploaded document into the candidate's words.
 *
 * Nothing under `lib/candidate/` imports Next; this file imports nothing from
 * the app either — an extension and some bytes in, text or a refusal out.
 *
 * **Why these two parsers.** Both are pure JavaScript with no native addon, no
 * system binary and no headless browser, because this runs inside a Server
 * Action on Vercel where none of those exist.
 *
 * - **PDF — `unpdf` (MIT).** Ships a *prebuilt* pdf.js configured for
 *   serverless: no `pdf.worker.js` to locate at runtime (the thing that breaks
 *   `pdfjs-dist` under a bundler) and no `canvas` peer unless a page is
 *   rendered. Zero runtime dependencies.
 * - **DOCX — `mammoth` (BSD-2-Clause).** Pure JS over `jszip`; `extractRawText`
 *   skips the HTML conversion, which is all we want — a letter is written from
 *   what the CV says, not how it is laid out.
 *
 * Both imported dynamically: they are large, and a top-level import would pull
 * pdf.js into a request whose CV turns out to be `.md`.
 *
 * **No OCR, and no fallback to an older document.** A scanned PDF parses fine
 * and yields an empty string, which `assertDraftable` refuses as `absent`;
 * drafting from the second-newest document would write a letter from a CV the
 * user did not choose and say nothing about it.
 */

/**
 * The formats that can be turned into text.
 *
 * ⚠️ **Strictly narrower than what `resumes` accepts on upload**, deliberately.
 * `OBJECT_KINDS.resumes` also takes `.doc`, `.odt` and `.rtf` — worth storing
 * whether or not anything can read them, but a parser each is three
 * dependencies for a case one "Save As" fixes. They are refused by name; see
 * `describeMissingBackground` in `cover-letter-actions.ts`.
 *
 * Adding a format means adding it here *and* a branch in
 * {@link extractProfileText}; the exhaustiveness check there enforces that.
 */
export const READABLE_PROFILE_EXTENSIONS = [
  ".md",
  ".txt",
  ".pdf",
  ".docx",
] as const

export type ReadableProfileExtension =
  (typeof READABLE_PROFILE_EXTENSIONS)[number]

export function isReadableProfileExtension(
  extension: string
): extension is ReadableProfileExtension {
  return (READABLE_PROFILE_EXTENSIONS as readonly string[]).includes(extension)
}

/**
 * Extraction did not produce text.
 *
 * Distinct from an empty string, which means a document with nothing in it and
 * is already refused by `assertDraftable`. This means the parser could not read
 * the file at all — a damaged upload, or a name that lies about the format —
 * and the user's next move is different.
 *
 * The underlying error stays on `cause` for the log and never reaches a message:
 * pdf.js and jszip both throw text about internal structure.
 */
export class ProfileTextError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ProfileTextError"
  }
}

/**
 * The text of one uploaded document, verbatim.
 *
 * The *only* source for anything the letter claims about the candidate, so
 * nothing here rewrites, summarises or reflows it.
 *
 * ⚠️ **Every failure mode is a throw, never partial text.** A letter drafted
 * from half a document reads exactly like one drafted from all of it, so a
 * corrupt PDF or a `.docx` that is not a zip reaches the caller as a
 * {@link ProfileTextError}.
 */
export async function extractProfileText(
  extension: ReadableProfileExtension,
  bytes: Uint8Array
): Promise<string> {
  switch (extension) {
    case ".md":
    case ".txt":
      // `fatal: false`, which is the default: a stray byte should degrade one
      // character rather than fail the draft. These are files the user wrote,
      // so a decoding error means a mislabelled file, and the length check in
      // `assertDraftable` is what catches a document that turned out to be
      // nothing.
      return new TextDecoder().decode(bytes)

    case ".pdf":
      return extractPdfText(bytes)

    case ".docx":
      return extractDocxText(bytes)

    default: {
      const _exhaustive: never = extension
      return _exhaustive
    }
  }
}

/**
 * pdf.js, through `unpdf`'s serverless build.
 *
 * ⚠️ **The bytes are copied first, and that is not defensive tidiness.** pdf.js
 * *transfers* the buffer it is given — after this call the caller's
 * `Uint8Array` is backed by a detached `ArrayBuffer` and every read of it
 * throws. Handing it the store's own buffer would turn "extract the text" into
 * an action at a distance on a value the caller still holds. A CV is capped at
 * 3 MiB by `upload-validation.ts`, so the copy is not worth avoiding.
 *
 * `mergePages: true` because a CV is one document; page boundaries are a
 * printing artefact and a letter written from page two only is not a thing we
 * want to be able to produce.
 */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText } = await import("unpdf")

  try {
    const { text } = await extractText(Uint8Array.from(bytes), {
      mergePages: true,
    })

    return text
  } catch (cause) {
    throw new ProfileTextError("that PDF could not be read", { cause })
  }
}

/**
 * `mammoth.extractRawText`, which walks the document body and ignores styling.
 *
 * A DOCX is a zip, and a zip is a decompression surface: a small archive can
 * expand to a very large `document.xml`. The upload cap bounds the input at
 * 3 MiB and `MAX_BACKGROUND_CHARS` refuses the output, but nothing bounds the
 * memory in between — an acceptable exposure for a closed-signup app where the
 * only person who can upload is the account holder, and the thing to revisit
 * first if that ever stops being true.
 */
async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth")

  try {
    const { value } = await mammoth.extractRawText({
      buffer: Buffer.from(bytes),
    })

    return value
  } catch (cause) {
    throw new ProfileTextError("that Word document could not be read", {
      cause,
    })
  }
}
