import {
  downloadPostingDocument,
  type PostingDocumentDownload,
} from "@/lib/posting-documents/download-posting-document"
import type { TailoredResumeStore } from "@workspace/user-storage"

/**
 * Fetching one stored tailored resume.
 *
 * Everything about how — the ownership property, the conflated `not-found`, the
 * shape check before the store is touched, and why the filename comes back
 * beside the bytes — belongs to {@link downloadPostingDocument}, because a cover
 * letter is fetched the identical way. What is this feature's own is the label
 * the file is named with.
 */

export type TailoredResumeDownload = PostingDocumentDownload

/**
 * The tailored resume this user generated for this Posting.
 *
 * The `label` is "Tailored resume" and not "Resume" — `tailored-resume-ref.ts`
 * says why the distinction matters.
 */
export async function downloadTailoredResume(
  userId: string,
  postingId: string,
  resumes: TailoredResumeStore
): Promise<TailoredResumeDownload> {
  return downloadPostingDocument(userId, postingId, resumes, {
    kind: "tailored-resumes",
    label: "Tailored resume",
  })
}
