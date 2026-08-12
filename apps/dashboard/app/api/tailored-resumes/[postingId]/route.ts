import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser } from "@/lib/auth/current-user"
import { postingDocumentResponse } from "@/lib/posting-documents/posting-document-response"
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
 * ⚠️ **Three things fetch this URL**: the download link takes it as a file,
 * **Edit** takes the body as text into the editor, and **Download PDF** renders
 * that text with `exportMarkdownToPdf`. One route serves all three because they
 * want the same bytes under the same ownership rule, and
 * `Content-Disposition: attachment` is harmless to the two using `fetch`.
 *
 * Under `/api/` deliberately, so `proxy.ts`'s redirect→401 conversion applies —
 * otherwise an unauthenticated `fetch` follows a 307 and gets HTML with a
 * success status. The two button paths branch on that status code.
 *
 * The path segment is the Posting id alone: a tailored resume has exactly one
 * extension, and a URL letting the caller choose suggests they can. The PDF is
 * made in the browser and never exists on this side.
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

  // The status→code mapping and every header live in
  // `postingDocumentResponse`, shared with the cover-letter route. The 404/500
  // split survives the merge — the two button paths branch on it.
  return postingDocumentResponse(resume)
}
