/**
 * `Promise.allSettled`, but with a ceiling on how many calls are in flight.
 *
 * Its own module because there are now two listings that need it — documents
 * and cover letters — and both need it for the same reason: S3 user metadata is
 * not returned by a listing, so a display name costs one `head()` per item and
 * the fan-out is however many objects the user happens to have. See
 * `lib/documents/list-documents.ts` and `lib/cover-letters/list-cover-letters.ts`
 * for why that N+1 is deliberate in each.
 *
 * Imports nothing, so a test can reach it — and, more to the point, so neither
 * listing has to carry its own copy. Two copies of a bounded fan-out is how one
 * of them quietly gets a different bound.
 */

/**
 * Same contract as `allSettled` — results are positional and a rejection never
 * fails the whole batch — which is what lets a caller keep treating each row
 * independently.
 *
 * The workers share one array iterator rather than slicing the input into
 * chunks. `next()` is synchronous and JavaScript is single-threaded, so no two
 * workers can ever be handed the same entry, and a worker that finishes early
 * immediately takes the next item instead of idling until its chunk-mates are
 * done. Chunking would make the batch as slow as the slowest item in each
 * chunk, which for one slow S3 response is most of the point of bounding it.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  const queue = items.entries()

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      // Nothing thrown escapes the loop body, so the shared iterator is never
      // closed early out from under the other workers.
      for (const [index, item] of queue) {
        try {
          results[index] = { status: "fulfilled", value: await run(item) }
        } catch (reason) {
          results[index] = { status: "rejected", reason }
        }
      }
    }
  )

  await Promise.all(workers)

  return results
}
