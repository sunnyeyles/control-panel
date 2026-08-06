import { coverLetterFilename } from "@/lib/cover-letters/cover-letter-ref"
import { formatUtcDateTime } from "@/lib/format-utc-datetime"
import {
  HEAD_CONCURRENCY,
  settleWithConcurrency,
} from "@/lib/settle-with-concurrency"
import {
  isUserStorageError,
  type CoverLetterStore,
  type StoredCoverLetter,
} from "@workspace/user-storage"

/**
 * The cover-letter metadata rendered for one visible Posting.
 *
 * This crosses into the table's client boundary, so it contains only strings.
 * It also contains only fields that the table actually renders: a draft time,
 * an accessible name, and the address and filename the two controls need.
 */
export interface CoverLetterRow {
  postingId: string
  draftedAt: string
  displayName: string
  filename: string
}

/**
 * Reads cover-letter metadata for exactly the Postings on one table page.
 *
 * A missing object is the ordinary undrafted state. Any other failure means
 * the store could not be relied on, so it rejects for the page to show its
 * existing storage-failure alert rather than claiming the affected rows are
 * undrafted.
 *
 * ⚠️ **An array, not a `Map` keyed by Posting.** This result crosses the RSC
 * boundary into the table's client components, where a `Map` is an awkward
 * payload — so the page used to flatten one straight back to `.values()`. It is
 * given exactly the ids being rendered, so it is bounded by `PAGE_SIZE`, and the
 * per-row scan in `useCoverLetter` is bounded with it; the keying only paid for
 * itself back when the page awaited this and looked rows up server-side.
 */
export async function loadCoverLetterRows(
  userId: string,
  postingIds: readonly string[],
  letters: CoverLetterStore
): Promise<CoverLetterRow[]> {
  const settled = await settleWithConcurrency(
    postingIds,
    HEAD_CONCURRENCY,
    async (postingId) => {
      try {
        return await letters.head({ userId, postingId })
      } catch (error) {
        if (isUserStorageError(error) && error.code === "object_not_found") {
          return undefined
        }

        throw error
      }
    }
  )

  const rejected = settled.find((result) => result.status === "rejected")
  if (rejected?.status === "rejected") throw rejected.reason

  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value
      ? [toCoverLetterRow(result.value)]
      : []
  )
}

function toCoverLetterRow(letter: StoredCoverLetter): CoverLetterRow {
  const { postingId, draftedAt, provenance } = letter

  return {
    postingId,
    draftedAt: formatUtcDateTime(draftedAt),
    displayName: provenance.title ?? postingId,
    filename: coverLetterFilename({
      postingId,
      ...(provenance.title ? { title: provenance.title } : {}),
      ...(provenance.company ? { company: provenance.company } : {}),
    }),
  }
}
