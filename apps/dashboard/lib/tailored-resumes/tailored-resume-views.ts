import type { TailoredResumeStore } from "@workspace/user-storage"

import { formatUtcDateTime } from "@/lib/format-dates"
import { listPostingDocuments } from "@/lib/posting-documents/posting-document-views"

/**
 * The tailored-resume metadata rendered for one Posting.
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
 * Every tailored resume this user has, in one call.
 *
 * The single-listing shape and the error policy — reject on an unreadable
 * store, empty only for a never-written prefix — are `listPostingDocuments`'s
 * contract, shared with the cover letters.
 *
 * ⚠️ **It takes no posting ids and is not bounded by the page**, unlike the
 * letters' views. The cost is O(tailored resumes this user has) rather than
 * O(rows rendered) — for one person's job search that stays smaller than the
 * page size for a long time, and it does not grow when the page does.
 *
 * An array rather than a `Map`, because this crosses the RSC boundary into
 * client components, where a `Map` is an awkward payload.
 */
export async function loadTailoredResumeViews(
  userId: string,
  resumes: TailoredResumeStore
): Promise<TailoredResumeView[]> {
  const listed = await listPostingDocuments(userId, resumes)

  return listed.map((resume) => ({
    postingId: resume.postingId,
    // From the object's write time rather than the `generated-at` metadata,
    // because a listing carries no metadata — `instantFrom` in
    // `@workspace/user-storage` already falls back to exactly that. The two
    // differ by however long the `put` took.
    generatedAt: formatUtcDateTime(resume.generatedAt),
  }))
}
