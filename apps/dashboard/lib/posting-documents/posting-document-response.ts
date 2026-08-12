import { contentDisposition } from "@/lib/documents/content-disposition"

import type { PostingDocumentDownload } from "./download-posting-document"

/**
 * One `PostingDocumentDownload`, as the HTTP response both download routes
 * serve.
 *
 * The status→code mapping and the header set are one contract, spelled out once
 * rather than in each route. Imports nothing from Next (`Response` is a web
 * global), which is what makes the mapping testable.
 *
 * The headers, and why each is load-bearing:
 *
 * - **`Content-Disposition: attachment`** — `contentDisposition()` is reused for
 *   the header escaping, the half worth not writing twice.
 * - **`nosniff`** — a browser that sniffed this Markdown body as HTML would run
 *   it on this origin with the session cookie attached.
 * - **`private, no-store`** — personal data behind a CDN (a tailored resume is a
 *   home address and a phone number); also keeps it off a shared machine's disk.
 *
 * `not-found` and `failed` stay distinct: the buttons that `fetch` this body
 * branch on the status code to decide what to tell the user.
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
