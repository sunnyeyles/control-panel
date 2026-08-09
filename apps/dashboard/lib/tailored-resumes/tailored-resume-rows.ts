import type { TailoredResumeStore } from "@workspace/user-storage"

import { formatUtcDateTime } from "@/lib/format-dates"
import { listPostingDocuments } from "@/lib/posting-documents/posting-document-rows"

/**
 * The tailored-resume metadata rendered for one Posting.
 *
 * This crosses into the table's client boundary, so it contains only strings.
 * It also contains only what the panel renders: an address and a generated-on
 * date.
 *
 * ⚠️ **No `displayName` and no `filename`, unlike `CoverLetterRow`** — a
 * listing carries no provenance, so both are derived in the component from
 * the `PostingView` it already holds. Which is the same data, from the row
 * rather than from S3, and one fewer thing to be stale.
 */
export interface TailoredResumeRow {
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
 * letters' rows. The cost is O(tailored resumes this user has) rather than
 * O(rows rendered) — for one person's job search that stays smaller than the
 * page size for a long time, and it does not grow when the page does.
 *
 * An array rather than a `Map`, because this crosses the RSC boundary into
 * client components, where a `Map` is an awkward payload.
 */
export async function loadTailoredResumeRows(
  userId: string,
  resumes: TailoredResumeStore
): Promise<TailoredResumeRow[]> {
  const listed = await listPostingDocuments(userId, resumes)

  return listed.map((resume) => ({
    postingId: resume.postingId,
    generatedAt: formatUtcDateTime(resume.generatedAt),
  }))
}
