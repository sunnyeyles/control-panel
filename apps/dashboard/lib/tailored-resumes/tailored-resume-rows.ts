import { formatUtcDateTime } from "@/lib/format-utc-datetime"
import {
  isUserStorageError,
  type TailoredResumeStore,
} from "@workspace/user-storage"

/**
 * The tailored-resume metadata rendered for one Posting.
 *
 * This crosses into the table's client boundary, so it contains only strings.
 * It also contains only what the panel renders: an address and a generated-on
 * date.
 *
 * ⚠️ **No `displayName` and no `filename`, unlike `CoverLetterRow`** — see
 * {@link loadTailoredResumeRows} for why. Both are derived in the component from
 * the `PostingView` it already holds.
 */
export interface TailoredResumeRow {
  postingId: string
  generatedAt: string
}

/**
 * Every tailored resume this user has, in one call.
 *
 * ⚠️ **One `ListObjectsV2`, not one `HeadObject` per visible Posting, and the
 * difference is the whole reason this function does not look like
 * `loadCoverLetterRows`.** That one is handed the ids on the page and heads each
 * of them: twenty-five round trips per render, on every sort click, every page
 * click, and every tick of the five-second poll a running briefing turns on.
 * `docs/cover-letter-existence-plan.md` writes that cost down and recommends
 * exactly this as the fix; building the second feature the letters' way would
 * have doubled a number already recorded as a problem.
 *
 * The consequences of the swap, both deliberate:
 *
 * - **It takes no posting ids and is not bounded by the page.** The cost is
 *   O(tailored resumes this user has) rather than O(rows rendered). For one
 *   person's job search that is a smaller number than the page size for a long
 *   time, and it does not grow when the page does.
 * - **It carries no provenance.** ListObjectsV2 returns no user metadata, so
 *   there is no title and no company here to build a filename from, and
 *   `generatedAt` is the object's own write time rather than the `generated-at`
 *   header. That is enough for "exists, and when". Anything rendering the
 *   Posting's name uses the `PostingView` the detail already has — which is the
 *   same data, from the row rather than from S3, and one fewer thing to be
 *   stale.
 *
 * A missing prefix is the ordinary "nothing generated yet" state and yields an
 * empty array. Any other failure rejects, so the page can say the store could
 * not be relied on rather than claiming every Posting is un-generated.
 *
 * An array rather than a `Map`, for the reason `loadCoverLetterRows` gives: this
 * crosses the RSC boundary into client components, where a `Map` is an awkward
 * payload.
 */
export async function loadTailoredResumeRows(
  userId: string,
  resumes: TailoredResumeStore
): Promise<TailoredResumeRow[]> {
  let listed
  try {
    listed = await resumes.list(userId)
  } catch (error) {
    // A prefix with nothing under it lists empty rather than raising, so this
    // branch is a real failure — but the store's own `list` is free to raise
    // `object_not_found` for a bucket layout that has never been written to,
    // and "you have generated nothing" is the correct reading of that.
    if (isUserStorageError(error) && error.code === "object_not_found") {
      return []
    }

    throw error
  }

  return listed.map((resume) => ({
    postingId: resume.postingId,
    generatedAt: formatUtcDateTime(resume.generatedAt),
  }))
}
