import {
  listDocuments,
  type DocumentSummary,
} from "@/lib/documents/list-documents"
import type { ResumeStore } from "@workspace/user-storage"

import {
  extractProfileText,
  isReadableProfileExtension,
  ProfileTextError,
  type ReadableProfileExtension,
} from "./profile-text"

/**
 * Finding the candidate's own words to write a letter from.
 *
 * **Nothing here imports Next**, like everything else under this directory —
 * see `cover-letter-actions.ts` for why that matters.
 *
 * The whole of the "which document is the CV" decision lives here rather than
 * in the action, because it is the part with branches worth naming: a user with
 * no Resume-labelled document, a user whose only Resume is a `.rtf`, and a user
 * whose PDF turned out to be a scan are told three different things, and only
 * some of them have anything to do.
 *
 * **Which formats can be read is `profile-text.ts`'s answer, not this file's.**
 * #86 widened that answer from `.md` and `.txt` to PDF and DOCX as well, and
 * nothing here changed shape to allow it — which was the point of the ticket.
 */

/** Why there is nothing to write a letter from. Each is a distinct thing to say. */
export type NoBackgroundReason =
  /** Nothing in the shelf is labelled as a resume at all. */
  | "no-resume"
  /**
   * There is one, but it is a `.doc`, `.odt` or `.rtf` — accepted on upload,
   * and still without a parser. See `READABLE_PROFILE_EXTENSIONS`.
   */
  | "unreadable-format"
  /**
   * There is one in a format we do read, and reading it failed: a damaged file,
   * a file whose name lies about its format, or a PDF that is a scan with no
   * text layer in it at all.
   */
  | "extraction-failed"

export type CandidateBackground =
  | {
      ok: true
      /** The document's text, verbatim. The only source for anything about the candidate. */
      background: string
      /** What it was called, for a message that names the document actually used. */
      displayName: string
    }
  | { ok: false; reason: NoBackgroundReason }

/**
 * The most recent readable document the user labelled as a resume.
 *
 * **Most recent, and labelled.** The label is the user's own statement about
 * which document is their CV — guessing from a filename would mean a letter
 * written from a cover letter they uploaded last month. Recency breaks the tie
 * when there are several, which is the answer that needs no explanation.
 *
 * Built on {@link listDocuments} rather than on `ResumeStore` directly, because
 * that function already owns the awkward part: the document type lives in S3
 * user metadata, `list()` cannot return it, and recovering it costs a bounded
 * `head()` fan-out. Reimplementing that here would be a second copy of an N+1.
 */
export async function loadCandidateBackground(
  userId: string,
  resumes: ResumeStore
): Promise<CandidateBackground> {
  const documents = await listDocuments(userId, resumes)
  const labelled = documents.filter(
    (document) => document.documentType === "resume"
  )

  if (labelled.length === 0) return { ok: false, reason: "no-resume" }

  // `listDocuments` sorts newest first, so the first match is the newest. The
  // predicate is spelled as a type guard so the extension reaches
  // `extractProfileText` as a `ReadableProfileExtension` rather than a `string`
  // — that is what makes the exhaustive switch there load-bearing.
  const readable = labelled.find(
    (
      document
    ): document is DocumentSummary & { extension: ReadableProfileExtension } =>
      isReadableProfileExtension(document.extension)
  )

  if (!readable) return { ok: false, reason: "unreadable-format" }

  const fetched = await resumes.get({
    // The session's userId, never anything from a form. The store checks
    // ownership again underneath; this is what makes that check a second line
    // rather than the only one.
    userId,
    resumeId: readable.resumeId,
    extension: readable.extension,
  })

  let background: string
  try {
    background = await extractProfileText(
      readable.extension,
      fetched.bytes ?? new Uint8Array()
    )
  } catch (error) {
    if (error instanceof ProfileTextError) {
      // ⚠️ **Not a fallback to the next-newest document.** The user labelled
      // this one, so a letter written from an older CV would be written from a
      // document they did not choose, with nothing saying so. Refusing here is
      // the same rule `assertDraftable` follows one step later.
      console.error(
        "cover-letters: could not extract text from",
        readable.file,
        error.cause ?? error
      )
      return { ok: false, reason: "extraction-failed" }
    }

    // A storage failure, or something genuinely unexpected. The action turns
    // this into `storageMessage("read", …)`, which is where it belongs.
    throw error
  }

  return {
    ok: true,
    background,
    displayName: readable.displayName,
  }
}
