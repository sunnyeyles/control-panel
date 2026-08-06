/**
 * `Promise.allSettled`, but with a ceiling on how many calls are in flight.
 *
 * Its own module because documents and visible cover-letter rows both need
 * bounded metadata reads. S3 listings carry no user metadata, while the
 * postings table needs one `head()` per visible letter. See
 * `lib/documents/list-documents.ts` and
 * `lib/cover-letters/cover-letter-rows.ts`.
 *
 * Imports nothing, so a test can reach it — and, more to the point, so neither
 * caller has to carry its own copy. Two copies of a bounded fan-out is how one
 * of them quietly gets a different bound.
 */

/**
 * How many `head()` calls may be in flight at once for document and
 * cover-letter metadata reads.
 *
 * Eight is chosen to be uninteresting: comfortably faster than serial for the
 * handful of objects these lists realistically hold, and bounded for the case
 * nobody planned for. One constant so the two callers cannot drift apart.
 */
export const HEAD_CONCURRENCY = 8

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
