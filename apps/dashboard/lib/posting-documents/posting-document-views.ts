import { isUserStorageError } from "@workspace/user-storage"

/**
 * The read both Posting-Document view modules are built on: everything this
 * user has of one kind, in one request, with one error policy.
 *
 * ⚠️ **One `ListObjectsV2`, not one `HeadObject` per visible Posting.** The
 * fan-out this replaced was 25 S3 requests per *render* — every sort click,
 * every page click, and every tick of the five-second poll a running briefing
 * turns on. A document's key ends in the Posting's id, so the set of existing
 * ids falls out of the listing and the store stays the single source of truth
 * — no column to keep in step with S3, and no consistency question.
 * `docs/cover-letter-existence-plan.md` weighed the alternatives; it is in git
 * history, deleted with the work it described.
 *
 * ⚠️ **It takes the user and nothing else, and that is what lets it start
 * early.** Narrowing to the visible page is a synchronous filter over the
 * result — no part of it reaches the wire — so this request does not depend
 * on the postings query and must not queue behind it. The price is a request
 * that is sometimes wasted; one listing over an empty prefix is the cheapest
 * request S3 has.
 *
 * The error policy, previously decided differently by the two callers:
 *
 * - **A missing prefix is the ordinary "nothing generated yet" state** and
 *   yields an empty array. A prefix with nothing under it lists empty rather
 *   than raising, so S3 never takes this branch — but a store's `list` is
 *   free to raise `object_not_found` for a layout that has never been written
 *   to, and "you have nothing of this kind" is the correct reading.
 * - **Any other failure rejects, and that is a correctness property.** A
 *   store that cannot be read must reach the page's storage-failure alert. An
 *   empty array would tell someone who has already generated a document that
 *   they have not, and would offer to spend a model call replacing it.
 */
export async function listPostingDocuments<T>(
  userId: string,
  store: { list(userId: string): Promise<readonly T[]> }
): Promise<readonly T[]> {
  try {
    return await store.list(userId)
  } catch (error) {
    if (isUserStorageError(error) && error.code === "object_not_found") {
      return []
    }

    throw error
  }
}

/**
 * The views for one page of Postings, out of everything the listing found.
 *
 * ⚠️ **Filtered to the ids being rendered**, so the array crossing the RSC
 * boundary stays bounded by the page size however much someone has generated,
 * and the per-row scans in the client components stay bounded with it.
 *
 * Synchronous, and deliberately so: it is the half that never touches the
 * network, and separating it from the listing is what lets the listing start
 * without waiting for the postings query.
 */
export function postingDocumentViewsFor<T extends { postingId: string }, View>(
  listed: readonly T[],
  postingIds: readonly string[],
  toView: (item: T) => View
): View[] {
  const visible = new Set(postingIds)

  return listed.filter((item) => visible.has(item.postingId)).map(toView)
}
