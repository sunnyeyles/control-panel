import type { DocumentType, ResumeStore } from "@workspace/user-storage"

import { formatDocumentFile } from "./document-ref"

/** One row of the documents table. Everything is already display-ready. */
export interface DocumentSummary {
  resumeId: string
  extension: string
  /** What to show. Falls back to the id when the metadata could not be read. */
  displayName: string
  documentType?: DocumentType
  size: number
  uploadedAt: Date
  /** `{resumeId}{extension}` — the download route's path segment. */
  file: string
}

/**
 * How many `head()` calls are in flight at once.
 *
 * `ResumeStore.list()` paginates ListObjectsV2 to exhaustion, so the number of
 * items here is however many documents the user has — there is no natural
 * ceiling on it. Fanning all of them out at once would hand the SDK an
 * unbounded burst, exhaust its socket pool, and time out a page whose
 * `maxDuration` is 30 seconds; and it would do so only for the user who had
 * uploaded the most, which is the worst possible distribution of the failure.
 *
 * Eight is chosen to be uninteresting: comfortably faster than serial for the
 * handful of documents this realistically holds, and bounded for the case
 * nobody planned for. Deliberately a concurrency cap and **not** a cap on rows
 * — truncating the list would hide documents the user could otherwise delete,
 * and it would look identical to having uploaded fewer.
 */
const HEAD_CONCURRENCY = 8

/**
 * Every document a user has, newest first.
 *
 * ⚠️ **This is an N+1, and it is deliberate.** `ResumeStore.list()` cannot
 * return `originalFilename` or `documentType`: both live in S3 user metadata,
 * and ListObjectsV2 does not carry user metadata at all, so the underlying
 * store fills in `metadata: {}` for every listed object. Recovering a display
 * name therefore costs one `head()` per document.
 *
 * The alternatives are worse. Showing raw uuids makes the list useless; keeping
 * a second copy of the metadata in Postgres means two sources of truth for what
 * a file is called, and `artifacts` cannot hold it anyway — `artifacts.run_id`
 * is `NOT NULL` and references `runs`, so there is no row shape for something a
 * person uploaded. At the scale this operates on — one person's CVs, not a
 * document management system — a handful of extra HeadObject calls is the
 * cheapest correct option. Revisit if a user ever has hundreds. The fan-out is
 * bounded at {@link HEAD_CONCURRENCY} so that "hundreds" degrades rather than
 * falls over.
 *
 * A failed `head()` degrades one row rather than the page, and is logged. That
 * matters more than it looks in both directions: without the degradation, a
 * single object whose metadata is unreadable makes the whole documents page
 * throw and the user cannot even delete the thing causing it — and without the
 * log, a *systematic* failure renders every row as a raw uuid with nothing
 * anywhere saying why.
 */
export async function listDocuments(
  userId: string,
  resumes: ResumeStore
): Promise<DocumentSummary[]> {
  const listed = await resumes.list(userId)

  const settled = await settleWithConcurrency(
    listed,
    HEAD_CONCURRENCY,
    (item) =>
      resumes.head({
        userId,
        resumeId: item.resumeId,
        extension: item.extension,
      })
  )

  const summaries = listed.map((item, index) => {
    const head = settled[index]

    if (head?.status === "rejected") {
      // The one place this failure is visible. It is swallowed by design —
      // the row still renders from the listing — so if it is not written down
      // here it is not written down anywhere, and a broken IAM attachment
      // looks exactly like a user who never named their files.
      console.error(
        "documents: could not read metadata for",
        item.key,
        head.reason
      )
    }

    const detail = head?.status === "fulfilled" ? head.value : undefined

    return {
      resumeId: item.resumeId,
      extension: item.extension,
      displayName: detail?.originalFilename ?? formatDocumentFile(item),
      ...(detail?.documentType ? { documentType: detail.documentType } : {}),
      // From the listing, not the head: both are correct, and preferring the
      // listing keeps a row complete even when its head() failed.
      size: item.size,
      uploadedAt: item.uploadedAt,
      file: formatDocumentFile(item),
    }
  })

  // The store returns key order, which for uuids is arbitrary — it looks sorted
  // and is not, which is the kind of thing nobody notices until a user asks why
  // their newest CV is in the middle.
  return summaries.sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()
  )
}

/**
 * `Promise.allSettled`, but with at most `limit` calls in flight.
 *
 * Same contract as `allSettled` — results are positional and a rejection never
 * fails the whole batch — which is what lets the caller keep treating each row
 * independently.
 *
 * The workers share one array iterator rather than slicing the input into
 * chunks. `next()` is synchronous and JavaScript is single-threaded, so no two
 * workers can ever be handed the same entry, and a worker that finishes early
 * immediately takes the next item instead of idling until its chunk-mates are
 * done. Chunking would make the batch as slow as the slowest item in each
 * chunk, which for one slow S3 response is most of the point of bounding it.
 */
async function settleWithConcurrency<T, R>(
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
