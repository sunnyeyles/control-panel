import {
  postingDocumentFilename,
  type PostingDocumentNameParts,
} from "@/lib/posting-documents/posting-document-filename"

/**
 * Naming the file a cover-letter download produces. Imports nothing from Next.
 *
 * ⚠️ **`POSTING_ID_PATTERN` is deliberately not here.** A letter and a tailored
 * resume are addressed by exactly the same value, so the rule that value passes
 * belongs to neither feature — it lives in
 * `lib/posting-documents/posting-document-ref.ts`, which says why there is one
 * copy of it.
 */

/**
 * The filename a download is offered under. The naming rule is shared with the
 * tailored resume, which differs by a label and nothing else; this is the name
 * the letter's own call sites use.
 */
export function coverLetterFilename(parts: PostingDocumentNameParts): string {
  return postingDocumentFilename("Cover letter", parts)
}
