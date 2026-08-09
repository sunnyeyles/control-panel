import { contentDisposition } from "@/lib/documents/content-disposition"

import type { PostingDocumentDownload } from "./download-posting-document"

/**
 * One `PostingDocumentDownload`, as the HTTP response both download routes
 * serve.
 *
 * The two routes under `app/api/{cover-letters,tailored-resumes}/` used to
 * each spell out this mapping and these headers; the status→code mapping and
 * the header set are one contract, and this module imports nothing from Next
 * (`Response` is a web global, the same reason `download-posting-document.ts`
 * avoids Next) — which is what makes the mapping testable at all.
 *
 * The headers, and why each is load-bearing:
 *
 * - **`Content-Disposition: attachment`** — the kind is stored `inline`
 *   because these bytes were written by this application rather than
 *   uploaded, but a *download* is what the routes are for, so
 *   `contentDisposition()` is reused rather than restated. It also does the
 *   header escaping, which is the half worth not writing twice.
 * - **`nosniff`** — belt-and-braces beside a Markdown body: this is not an
 *   upload, so the stored-XSS argument that makes documents an attachment
 *   does not apply, but a browser that sniffed the body as HTML would still
 *   run it on this origin with the session cookie attached.
 * - **`private, no-store`** — personal data behind a CDN (a tailored resume
 *   is a home address and a phone number). `private` keeps it out of shared
 *   caches; `no-store` keeps it out of the browser's disk cache on a shared
 *   machine.
 *
 * `not-found` and `failed` stay distinct on purpose: the buttons that `fetch`
 * this body branch on the status code to decide what to tell the user.
 */
export function postingDocumentResponse(
  download: PostingDocumentDownload
): Response {
  if (download.status === "not-found") {
    return Response.json({ error: "Not found" }, { status: 404 })
  }

  if (download.status === "failed") {
    return Response.json({ error: "Download failed" }, { status: 500 })
  }

  return new Response(download.markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": contentDisposition(download.filename),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  })
}
