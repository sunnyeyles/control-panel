import type {
  CoverLetterStore,
  StoredCoverLetter,
} from "@workspace/user-storage"

import { formatUtcDateTime } from "@/lib/format-dates"
import {
  listPostingDocuments,
  postingDocumentViewsFor,
} from "@/lib/posting-documents/posting-document-views"

/**
 * The cover-letter facts rendered for one visible Posting.
 *
 * A `View` and not a `Row` (`NAMING.md` R5): it crosses into the table's client
 * boundary, so every `Date` is already a string — and there is no
 * `cover_letters` table for it to be a row of. What it projects is an **S3
 * listing**.
 *
 * ⚠️ **No `displayName` and no `filename`, and that absence is deliberate.**
 * Both come from S3 object metadata, which a listing does not return — so they
 * are computed at the point of use in `posting-detail.tsx` from the `PostingView`
 * the table already holds.
 */
export interface CoverLetterView {
  postingId: string
  draftedAt: string
}

/**
 * Every letter this user has drafted, in one request.
 *
 * The single-listing shape, the start-early property and the error policy —
 * reject on an unreadable store, empty only for a never-written prefix — are
 * `listPostingDocuments`'s contract, shared with the tailored resumes.
 */
export async function listCoverLetters(
  userId: string,
  letters: CoverLetterStore
): Promise<readonly StoredCoverLetter[]> {
  return listPostingDocuments(userId, letters)
}

/**
 * The views for one page of Postings, out of everything {@link listCoverLetters}
 * found. The bounded-filter shape is `postingDocumentViewsFor`'s; what belongs
 * here is the field mapping.
 */
export function coverLetterViewsFor(
  listed: readonly StoredCoverLetter[],
  postingIds: readonly string[]
): CoverLetterView[] {
  return postingDocumentViewsFor(listed, postingIds, (letter) => ({
    postingId: letter.postingId,
    // From the object's write time rather than the `drafted-at` metadata,
    // because a listing carries no metadata — `toStoredCoverLetter` in
    // `@workspace/user-storage` already falls back to exactly that. The two
    // differ by however long the `put` took.
    draftedAt: formatUtcDateTime(letter.draftedAt),
  }))
}
