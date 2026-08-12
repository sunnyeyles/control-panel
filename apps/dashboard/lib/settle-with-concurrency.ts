/**
 * `Promise.allSettled`, but with a ceiling on how many calls are in flight.
 *
 * Its own module because bulk posting delete fans out one pair of object-store
 * deletes per selected Posting (`lib/postings/posting-actions.ts`), and that
 * bound has to live somewhere a future second caller cannot quietly diverge
 * from. Imports nothing, so a test can reach it — two copies of a bounded
 * fan-out is how one of them quietly gets a different bound.
 */

/**
 * Same contract as `allSettled` — results are positional and a rejection never
 * fails the whole batch — so a caller keeps treating each row independently.
 *
 * The workers share one array iterator rather than slicing into chunks.
 * `next()` is synchronous and JavaScript single-threaded, so no two workers get
 * the same entry, and one that finishes early takes the next item instead of
 * idling. Chunking would make the batch as slow as the slowest item in each
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
