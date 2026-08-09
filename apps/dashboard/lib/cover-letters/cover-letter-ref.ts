import {
  postingDocumentFilename,
  type PostingDocumentNameParts,
} from "@/lib/posting-documents/posting-document-filename"

/**
 * Naming the file a cover-letter download produces.
 *
 * Imports nothing from Next, for the reason `lib/documents/document-ref.ts`
 * gives about itself: a test can reach it, and the shape a value must have
 * before it becomes a key segment is exactly the thing worth testing.
 *
 * ⚠️ **`POSTING_ID_PATTERN` is no longer here**, and the move is what the
 * **Posting Document** entry in `CONTEXT.md` describes: a letter and a tailored
 * resume are addressed by exactly the same value, so the rule that value passes
 * belongs to neither feature. It lives in
 * `lib/posting-documents/posting-document-ref.ts`, whose comment explains at
 * length why there is one copy of it.
 */

/** What is known about the Posting a letter was drafted for, for naming it. */
export type CoverLetterNameParts = PostingDocumentNameParts

/**
 * The filename a download is offered under.
 *
 * The naming rule lives in `lib/posting-documents/posting-document-filename.ts`
 * because the tailored resume needs the identical one — the two differ by a
 * label and by nothing else, and the character cleaning inside it is the half
 * worth having one copy of. This stays as the name the letter's own call sites
 * use.
 */
export function coverLetterFilename(parts: CoverLetterNameParts): string {
  return postingDocumentFilename("Cover letter", parts)
}
