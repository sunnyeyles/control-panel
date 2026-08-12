import { tailoredResumeFilename } from "@/lib/tailored-resumes/tailored-resume-ref"

/**
 * A plain anchor with `download`, not `next/link` — the same reasoning as the
 * cover letter's: prefetching a download route would have the browser fetch the
 * whole file on hover, and the route answers with an attachment disposition,
 * which is not something the client router can navigate to.
 *
 * ⚠️ **The filename is built here from the Posting, not read off storage.**
 * `listTailoredResumes` uses one `ListObjectsV2`, which carries no user
 * metadata, so the row has no title or company to name the file by; the detail
 * panel already holds both from Postgres. The route's own `Content-Disposition`
 * comes from object metadata, so the two differ only when a Posting was
 * re-found under a new title — in which case the browser honours this one, and
 * the newer name is the better answer anyway.
 */
export function TailoredResumeDownloadLink({
  postingId,
  title,
  company,
}: {
  postingId: string
  title: string
  company: string
}) {
  return (
    <a
      href={`/api/tailored-resumes/${postingId}`}
      download={tailoredResumeFilename({ postingId, title, company })}
      className="text-sm underline underline-offset-4 hover:no-underline"
    >
      Download
      <span className="sr-only"> the tailored resume for {title}</span>
    </a>
  )
}
