import { listDocuments } from "@/lib/documents/list-documents"
import type { ResumeStore } from "@workspace/user-storage"

/**
 * Finding the candidate's own words to write a letter from.
 *
 * **Nothing here imports Next**, like everything else under this directory —
 * see `cover-letter-actions.ts` for why that matters.
 *
 * The whole of the "which document is the CV" decision lives here rather than
 * in the action, because it is the part with branches worth naming: a user with
 * no Resume-labelled document and a user whose only Resume is a PDF are told
 * different things, and only one of them has anything to do.
 */

/**
 * The formats this app can turn into text today.
 *
 * ⚠️ **Not a policy choice — a capability statement.** Reading a PDF or a DOCX
 * means a parser, and a parser that silently returns the wrong text would put
 * invented substance into a letter signed by the user. That work is #86, and
 * until it lands refusing is the honest answer. The `letter` CLI restricts
 * itself the same way and says so for the same reason.
 *
 * `resumes` accepts far more than this on upload, deliberately: a user's PDF CV
 * is worth storing whether or not anything can read it yet.
 */
export const READABLE_PROFILE_EXTENSIONS = [".md", ".txt"] as const

/** Why there is nothing to write a letter from. Each is a distinct thing to say. */
export type NoBackgroundReason =
  /** Nothing in the shelf is labelled as a resume at all. */
  | "no-resume"
  /** There is one, but it is a PDF or a DOCX and cannot be read yet. */
  | "unreadable-format"

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

  // `listDocuments` sorts newest first, so the first match is the newest.
  const readable = labelled.find((document) =>
    (READABLE_PROFILE_EXTENSIONS as readonly string[]).includes(
      document.extension
    )
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

  return {
    ok: true,
    // `fatal: false`, which is the default: a stray byte should degrade one
    // character rather than fail the draft. These are `.md` and `.txt` files
    // the user wrote, so a decoding error means a mislabelled file, and the
    // length check in `assertDraftable` is what catches a document that turned
    // out to be nothing.
    background: new TextDecoder().decode(fetched.bytes ?? new Uint8Array()),
    displayName: readable.displayName,
  }
}
