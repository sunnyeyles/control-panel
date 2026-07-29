import type { DocumentType, ResumeStore } from "@workspace/user-storage"

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
 * cheapest correct option. Revisit if a user ever has hundreds.
 *
 * A failed `head()` degrades one row rather than the page. That matters more
 * than it looks: without it, a single object whose metadata is unreadable makes
 * the whole documents page throw, and the user cannot even delete the thing
 * causing it.
 */
export async function listDocuments(
  userId: string,
  resumes: ResumeStore
): Promise<DocumentSummary[]> {
  const listed = await resumes.list(userId)

  const settled = await Promise.allSettled(
    listed.map((item) =>
      resumes.head({
        userId,
        resumeId: item.resumeId,
        extension: item.extension,
      })
    )
  )

  const summaries = listed.map((item, index) => {
    const head = settled[index]
    const detail = head?.status === "fulfilled" ? head.value : undefined

    return {
      resumeId: item.resumeId,
      extension: item.extension,
      displayName:
        detail?.originalFilename ?? `${item.resumeId}${item.extension}`,
      ...(detail?.documentType ? { documentType: detail.documentType } : {}),
      // From the listing, not the head: both are correct, and preferring the
      // listing keeps a row complete even when its head() failed.
      size: item.size,
      uploadedAt: item.uploadedAt,
      file: `${item.resumeId}${item.extension}`,
    }
  })

  // The store returns key order, which for uuids is arbitrary — it looks sorted
  // and is not, which is the kind of thing nobody notices until a user asks why
  // their newest CV is in the middle.
  return summaries.sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()
  )
}
