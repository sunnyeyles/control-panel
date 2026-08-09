import {
  downloadPostingDocument,
  type PostingDocumentDownload,
} from "@/lib/posting-documents/download-posting-document"
import type { CoverLetterStore } from "@workspace/user-storage"

/**
 * Fetching one stored cover letter for download.
 *
 * Everything about how — the ownership property, the conflated `not-found`, the
 * shape check before the store is touched, and why the filename comes back
 * beside the bytes — belongs to {@link downloadPostingDocument}, because a
 * tailored resume is fetched the identical way. What is this feature's own is
 * the label the file is named with.
 */

export type CoverLetterDownload = PostingDocumentDownload

/** The letter this user drafted for this Posting. */
export async function downloadCoverLetter(
  userId: string,
  postingId: string,
  letters: CoverLetterStore
): Promise<CoverLetterDownload> {
  return downloadPostingDocument(userId, postingId, letters, {
    kind: "cover-letters",
    label: "Cover letter",
  })
}
