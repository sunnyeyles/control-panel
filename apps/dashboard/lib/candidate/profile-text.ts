/**
 * Turning an uploaded document into the candidate's words.
 *
 * **Nothing under `lib/candidate/` imports Next**, which is the rule the whole
 * of `lib/` follows — see the Server Action section of `apps/dashboard/CLAUDE.md`
 * for why. This file goes further and imports nothing from this app either: an
 * extension and some bytes in, text or a refusal out.
 *
 * This module is the whole of #86. The `resumes` kind has always accepted a
 * PDF and a DOCX on upload, and drafting has always refused them — an upload
 * that succeeds followed by a refusal that names the file you just uploaded is
 * the worst seam a feature can ship with. Closing it is a parser dependency and
 * nothing else: {@link loadCandidateBackground} still returns the same shape and
 * still hands `assertDraftable` a string.
 *
 * ## Why these two parsers
 *
 * Both are pure JavaScript with no native addon, no system binary and no
 * headless browser, because this runs inside a Next.js Server Action on Vercel
 * where none of those exist.
 *
 * - **PDF — `unpdf` (MIT).** It ships a *prebuilt* pdf.js configured for
 *   serverless: no `pdf.worker.js` to locate at runtime, which is the thing that
 *   breaks `pdfjs-dist` under a bundler, and no `canvas` peer unless you render
 *   a page (we only read text, so the optional `@napi-rs/canvas` peer stays
 *   uninstalled). It has zero runtime dependencies. `pdfjs-dist` used directly
 *   needs that worker configuration; `pdf-parse` wraps an older pdf.js and is
 *   the less-maintained of the three.
 * - **DOCX — `mammoth` (BSD-2-Clause).** The conventional choice, pure JS over
 *   `jszip`. {@link https://www.npmjs.com/package/mammoth `extractRawText`}
 *   skips the HTML conversion entirely, which is the whole of what we want: a
 *   cover letter is written from what the CV *says*, not how it is laid out.
 *
 * Both are imported dynamically. They are large — pdf.js in particular — and a
 * top-level import would pull them into every module graph that reaches this
 * file, including the request that turns out to have a `.md` CV and needs
 * neither.
 *
 * ## What this deliberately does not do
 *
 * **No OCR, and no fallback to an older document.** A PDF that is a scan of a
 * printed CV parses perfectly and yields an empty string; that reaches
 * `assertDraftable` as `absent` and is refused there, in the same words as an
 * empty `.md`, rather than being papered over. The alternative — drafting from
 * the second-newest document — would write a letter from a CV the user did not
 * choose and say nothing about it. Every refusal here is loud for the same
 * reason `assertDraftable` refuses rather than truncates.
 */

/**
 * The formats that can be turned into text.
 *
 * ⚠️ **Strictly narrower than what `resumes` accepts on upload**, and that gap
 * is deliberate rather than an oversight. `OBJECT_KINDS.resumes` also takes
 * `.doc`, `.odt` and `.rtf`; a user's CV is worth storing whether or not
 * anything can read it, and those three are legacy or niche enough that a
 * parser for each would be three more dependencies for a case the user can fix
 * in one "Save As". They are refused by name — see `describeMissingBackground`
 * in `cover-letter-actions.ts` — not lumped in with PDF and Word.
 *
 * Adding a format means adding it here *and* a branch in
 * {@link extractProfileText}; the exhaustiveness check there is what makes the
 * two impossible to change independently.
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
 * A distinct error rather than an empty string, because the two mean opposite
 * things to the caller: an empty string is a document with nothing in it, which
 * `assertDraftable` already refuses in the words that fit; this is *the parser
 * could not read the file at all*, which is a damaged upload or a file whose
 * name lies about its format, and the user's next move is different.
 *
 * The underlying error is kept on `cause` for the log and never put in a
 * message — pdf.js and jszip both throw text about internal structure that
 * means nothing to the person holding the CV.
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
 * Whatever comes back is the *only* source for anything the letter claims about
 * the candidate, so nothing here rewrites, summarises or reflows it — the
 * parsers' own line breaks go through untouched and the length bounds in
 * `assertDraftable` are applied to exactly this string by the caller.
 *
 * ⚠️ **Every failure mode is a throw, and none is a crash.** A corrupt PDF, a
 * text file renamed `.pdf`, a `.docx` that is not a zip: all of them reach the
 * caller as a {@link ProfileTextError}. Returning partial text from a parser
 * that errored would be the one outcome worse than refusing — a letter drafted
 * from half a document reads exactly like one drafted from all of it.
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
