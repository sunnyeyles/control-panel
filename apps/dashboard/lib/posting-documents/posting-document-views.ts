import { isUserStorageError } from "@workspace/user-storage"

/**
 * The read both Posting-Document view modules are built on: everything this
 * user has of one kind, in one request, with one error policy.
 *
 * ⚠️ **One `ListObjectsV2`, not one `HeadObject` per visible Posting.** The
 * fan-out this replaced was 25 S3 requests per *render* — every sort click, page
 * click, and tick of the five-second poll a running briefing turns on. A key ends
 * in the Posting's id, so existing ids fall out of the listing and the store
 * stays the single source of truth: no column to keep in step with S3.
 *
 * ⚠️ **It takes the user and nothing else, and that is what lets it start
 * early.** Narrowing to the visible page is a synchronous filter, so this request
 * must not queue behind the postings query. The price is an occasionally wasted
 * listing over an empty prefix — the cheapest request S3 has.
 *
 * The error policy, previously decided differently by the two callers:
 *
 * - **A missing prefix is the ordinary "nothing generated yet" state.** S3 lists
 *   an empty prefix rather than raising, but a store's `list` may raise
 *   `object_not_found` for a layout never written to.
 * - **Any other failure rejects, and that is a correctness property.** An empty
 *   array would tell someone who has already generated a document that they have
 *   not, and offer to spend a model call replacing it.
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
 * boundary stays bounded by the page size however much someone has generated.
 *
 * Synchronous by design: separating the half that never touches the network is
 * what lets the listing start without waiting for the postings query.
 */
export function postingDocumentViewsFor<T extends { postingId: string }, View>(
  listed: readonly T[],
  postingIds: readonly string[],
  toView: (item: T) => View
): View[] {
  const visible = new Set(postingIds)

  return listed.filter((item) => visible.has(item.postingId)).map(toView)
}
