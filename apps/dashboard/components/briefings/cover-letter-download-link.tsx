import type { CoverLetterRow } from "@/lib/cover-letters/cover-letter-rows"

/**
 * A plain anchor with `download`, not `next/link` — the same reasoning as the
 * documents table. Prefetching a download route would have the browser fetch the
 * whole file on hover, and the route answers with an attachment disposition,
 * which is not something the client router can navigate to.
 */
export function CoverLetterDownloadLink({
  letter,
}: {
  letter: Pick<CoverLetterRow, "postingId" | "displayName" | "filename">
}) {
  return (
    <a
      href={`/api/cover-letters/${letter.postingId}`}
      download={letter.filename}
      className="text-sm underline underline-offset-4 hover:no-underline"
    >
      Download
      <span className="sr-only">
        {" "}
        the cover letter for {letter.displayName}
      </span>
    </a>
  )
}
