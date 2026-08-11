/**
 * A plain anchor with `download`, not `next/link` — the same reasoning as the
 * documents table. Prefetching a download route would have the browser fetch the
 * whole file on hover, and the route answers with an attachment disposition,
 * which is not something the client router can navigate to.
 *
 * ⚠️ **The name and the filename are props rather than fields of a
 * `CoverLetterView`.** They used to come from the letter's stored S3 provenance,
 * which is metadata a `ListObjectsV2` does not return — and one listing is now
 * how the whole page learns which Postings have letters. See
 * `lib/cover-letters/cover-letter-views.ts`. The caller derives both from the
 * Posting it is already rendering.
 */
export function CoverLetterDownloadLink({
  postingId,
  displayName,
  filename,
}: {
  postingId: string
  /** What the accessible label names — the Posting's title. */
  displayName: string
  filename: string
}) {
  return (
    <a
      href={`/api/cover-letters/${postingId}`}
      download={filename}
      className="text-sm underline underline-offset-4 hover:no-underline"
    >
      Download
      <span className="sr-only"> the cover letter for {displayName}</span>
    </a>
  )
}
