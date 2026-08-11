import type {
  StoredTailoredResume,
  TailoredResumeStore,
} from "@workspace/user-storage"

import { formatUtcDateTime } from "@/lib/format-dates"
import {
  listPostingDocuments,
  postingDocumentViewsFor,
} from "@/lib/posting-documents/posting-document-views"

/**
 * The tailored-resume metadata rendered for one visible Posting.
 *
 * A `View` and not a `Row` (`NAMING.md` R5): it crosses into the table's client
 * boundary, so every `Date` is already a string — and there is no
 * `tailored_resumes` table for it to be a row of. What it projects is an **S3
 * listing**. It also contains only what the panel renders: an address and a
 * generated-on date.
 *
 * ⚠️ **No `displayName` and no `filename`, unlike `CoverLetterView`** — a
 * listing carries no provenance, so both are derived in the component from
 * the `PostingView` it already holds. Which is the same data, from the row
 * rather than from S3, and one fewer thing to be stale.
 */
export interface TailoredResumeView {
  postingId: string
  generatedAt: string
}

/**
 * Every tailored resume this user has, in one request.
 *
 * The single-listing shape, the start-early property and the error policy —
 * reject on an unreadable store, empty only for a never-written prefix — are
 * `listPostingDocuments`'s contract, shared with the cover letters.
 */
export async function listTailoredResumes(
  userId: string,
  resumes: TailoredResumeStore
): Promise<readonly StoredTailoredResume[]> {
  return listPostingDocuments(userId, resumes)
}

/**
 * The views for one page of Postings, out of everything
 * {@link listTailoredResumes} found. The bounded-filter shape is
 * `postingDocumentViewsFor`'s; what belongs here is the field mapping.
 */
export function tailoredResumeViewsFor(
  listed: readonly StoredTailoredResume[],
  postingIds: readonly string[]
): TailoredResumeView[] {
  return postingDocumentViewsFor(listed, postingIds, (resume) => ({
    postingId: resume.postingId,
    // From the object's write time rather than the `generated-at` metadata,
    // because a listing carries no metadata — `instantFrom` in
    // `@workspace/user-storage` already falls back to exactly that. The two
    // differ by however long the `put` took.
    generatedAt: formatUtcDateTime(resume.generatedAt),
  }))
}
