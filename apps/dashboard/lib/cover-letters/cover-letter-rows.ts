import type {
  CoverLetterStore,
  StoredCoverLetter,
} from "@workspace/user-storage"

import { formatUtcDateTime } from "@/lib/format-dates"
import {
  listPostingDocuments,
  postingDocumentRowsFor,
} from "@/lib/posting-documents/posting-document-rows"

/**
 * The cover-letter facts rendered for one visible Posting.
 *
 * This crosses into the table's client boundary, so it contains only strings.
 *
 * ⚠️ **Two fields, and the ones that are gone left deliberately.** This used to
 * carry `displayName` and `filename` as well, both derived from the letter's
 * stored provenance. Those come from S3 *object metadata*, which a listing does
 * not return. They are not lost: `displayName` is the Posting's title and
 * `filename` is `coverLetterFilename()` over its title and company, and the
 * table already holds both for every row it renders — so they are computed at
 * the point of use in `components/jobs/postings/posting-detail.tsx` rather than
 * fetched.
 */
export interface CoverLetterRow {
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
 * The rows for one page of Postings, out of everything {@link listCoverLetters}
 * found. The bounded-filter shape is `postingDocumentRowsFor`'s; what belongs
 * here is the field mapping.
 */
export function coverLetterRowsFor(
  listed: readonly StoredCoverLetter[],
  postingIds: readonly string[]
): CoverLetterRow[] {
  return postingDocumentRowsFor(listed, postingIds, (letter) => ({
    postingId: letter.postingId,
    // From the object's write time rather than the `drafted-at` metadata,
    // because a listing carries no metadata — `toStoredCoverLetter` in
    // `@workspace/user-storage` already falls back to exactly that. The two
    // differ by however long the `put` took.
    draftedAt: formatUtcDateTime(letter.draftedAt),
  }))
}
