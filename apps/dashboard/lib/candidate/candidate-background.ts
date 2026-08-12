import { listDocuments } from "@/lib/documents/list-documents"
import type { PrismaClient } from "@workspace/db"
import type { ResumeStore } from "@workspace/user-storage"

import {
  extractProfileText,
  isReadableProfileExtension,
  ProfileTextError,
} from "./profile-text"

/**
 * Finding the candidate's own words to write from — which of a user's
 * **Documents** speaks for them, and what it says. Three callers with nothing
 * else in common: a Cover Letter, a Tailored Resume, and proposing Search
 * Criteria. **Nothing under `lib/candidate/` imports Next.**
 *
 * ⚠️ **It knows nothing about what is written from it.** No Posting, no agent, no
 * message a user reads — which is what lets a fourth caller appear without
 * touching anything here.
 *
 * The whole "which document is the CV" decision lives here rather than in the
 * action, because it is the part with branches worth naming: no Resume-labelled
 * document, a Resume that is a `.rtf`, and a PDF that turned out to be a scan are
 * told three different things.
 *
 * **Which formats can be read is `profile-text.ts`'s answer, not this file's.**
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
   * There is one in a format we do read, and the parser *threw*: a damaged
   * file, or a file whose name lies about its format.
   *
   * ⚠️ **Not the scanned-PDF case, however much it sounds like one.** A scan
   * parses perfectly and yields an empty string, so it travels on as
   * `background: ""` and `assertDraftable` refuses it as `absent` — the branch
   * whose message names the scan, and the document. Routing an empty extraction
   * here would trade that sentence for a vaguer one.
   */
  | "extraction-failed"

export type CandidateBackground =
  | {
      ok: true
      /** The document's text, verbatim. The only source for anything about the candidate. */
      background: string
      /** What it was called, for a message that names the document actually used. */
      displayName: string
      /**
       * Which document this text came out of — `documents.id`, the same uuid
       * that is the object's key segment.
       *
       * ⚠️ **Carried because a match has to be attributable to a document, and
       * that is the whole of how a score goes stale.** `postings.match_resume_id`
       * stores it; any other value means the score describes a CV since replaced.
       * Every other caller ignores the field.
       */
      documentId: string
    }
  | { ok: false; reason: NoBackgroundReason }

/**
 * The most recent document the user labelled as a resume, if it is readable.
 *
 * **Most recent, and labelled.** The label is the user's own statement about which
 * document is their CV — guessing from a filename would mean a letter written
 * from a cover letter they uploaded last month. Recency breaks the tie.
 *
 * Both stores answer different questions: Postgres says which document the user
 * called their resume, only the bucket has the bytes. Built on
 * {@link listDocuments} so "newest labelled resume" is decided in one place.
 */
export async function loadCandidateBackground(
  userId: string,
  prisma: PrismaClient,
  resumes: ResumeStore
): Promise<CandidateBackground> {
  const documents = await listDocuments(userId, prisma)
  const labelled = documents.filter(
    (document) => document.documentType === "resume"
  )

  // `listDocuments` sorts newest first, so `labelled[0]` is the only candidate.
  // ⚠️ **Deliberately not a `find()` for the newest *readable* one.** The user
  // labelled this document, so skipping past it to an older CV would write from
  // one they did not choose, with nothing saying so.
  const newest = labelled[0]
  if (newest === undefined) return { ok: false, reason: "no-resume" }

  // Narrowed through a const so the extension reaches `extractProfileText` as
  // a `ReadableProfileExtension` rather than a `string` — that is what makes
  // the exhaustive switch there load-bearing.
  const extension = newest.extension
  if (!isReadableProfileExtension(extension)) {
    return { ok: false, reason: "unreadable-format" }
  }

  const fetched = await resumes.get({
    // The session's userId, never anything from a form. The store checks
    // ownership again underneath; this is what makes that check a second line
    // rather than the only one.
    userId,
    resumeId: newest.documentId,
    extension,
  })

  let background: string
  try {
    background = await extractProfileText(
      extension,
      fetched.bytes ?? new Uint8Array()
    )
  } catch (error) {
    if (error instanceof ProfileTextError) {
      // ⚠️ **Not a fallback to the next-newest document**, for the reason above.
      // Refusing here is the rule `assertDraftable` follows one step later.
      console.error(
        "candidate: could not extract text from",
        newest.file,
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
    displayName: newest.displayName,
    documentId: newest.documentId,
  }
}
