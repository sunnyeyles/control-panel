import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser } from "@/lib/auth/current-user"
import { contentDisposition } from "@/lib/documents/content-disposition"
import { getTailoredResumeStore } from "@/lib/storage"
import { downloadTailoredResume } from "@/lib/tailored-resumes/download-tailored-resume"

/**
 * Fetch one tailored resume.
 *
 * **A Route Handler rather than a Server Action, and it has to be**, for the
 * reason `app/api/cover-letters/[postingId]/route.ts` gives: a Server Action's
 * return value is RSC-serialized, and there is no way to attach `Content-Type`
 * and `Content-Disposition` to it.
 *
 * ⚠️ **Three things fetch this URL, not one**, and the extras are why the
 * headers below are worth reading twice. The download link takes the response as
 * a file; the **Edit** button takes the body as text into the shared editor; and
 * the **Download PDF** button takes the body as text and renders it in the
 * browser with `exportMarkdownToPdf`. One route serves all three because they
 * want the same bytes under the same ownership rule — and `Content-Disposition:
 * attachment` is harmless to the two that read the body with `fetch`.
 *
 * Under `/api/` deliberately, so `proxy.ts`'s redirect→401 conversion applies:
 * without it an unauthenticated `fetch` would follow a 307 to the sign-in page
 * and receive an HTML document with a success status, unable to tell it was
 * refused. The two button paths depend on that directly — they branch on the
 * status code to decide what to say.
 *
 * The path segment is the Posting id alone — no extension, because a tailored
 * resume has exactly one (`.md`, fixed by `tailored-resume-store.ts`) and a URL
 * that let the caller choose one would be a URL that suggests they can. The PDF
 * is made in the browser and never exists on this side.
 */

/** Required of anything reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ postingId: string }> }
): Promise<Response> {
  // Before the params are even read. Both "not signed in" and "not on the
  // allowlist" answer identically — telling them apart would confirm to an
  // unapproved caller that their account exists.
  const caller = await requireUser(getCurrentUser, "tailored-resumes")

  if (!caller.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { postingId } = await params

  // ⚠️ **The session's userId, never anything from the URL.** The caller
  // supplies the last segment of the key and nothing else, so a request naming
  // another user's document cannot be spelled at all.
  const resume = await downloadTailoredResume(
    caller.userId,
    postingId,
    getTailoredResumeStore()
  )

  if (resume.status === "not-found") {
    return Response.json({ error: "Not found" }, { status: 404 })
  }

  if (resume.status === "failed") {
    return Response.json({ error: "Download failed" }, { status: 500 })
  }

  return new Response(resume.markdown, {
    headers: {
      // The kind is stored `inline` because these bytes were written by this
      // application rather than uploaded — but a *download* is one of the three
      // things this route is for, so `contentDisposition()` (which always emits
      // `attachment`) is reused rather than restated. It also does the header
      // escaping, which is the half worth not writing twice.
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": contentDisposition(resume.filename),
      // Belt-and-braces beside a Markdown body: this is not an upload, so the
      // stored-XSS argument that makes documents an attachment does not apply
      // here — but a browser that sniffed a resume as HTML would still run it on
      // this origin with the session cookie attached.
      "X-Content-Type-Options": "nosniff",
      // Personal data behind a CDN, and more of it than a cover letter carries:
      // a CV is a home address and a phone number. `private` keeps it out of
      // shared caches; `no-store` keeps it out of the browser's disk cache on a
      // shared machine.
      "Cache-Control": "private, no-store",
    },
  })
}
