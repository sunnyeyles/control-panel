import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser } from "@/lib/auth/current-user"
import { downloadCoverLetter } from "@/lib/cover-letters/download-cover-letter"
import { postingDocumentResponse } from "@/lib/posting-documents/posting-document-response"
import { getCoverLetterStore } from "@/lib/storage"

/**
 * Download one cover letter.
 *
 * **A Route Handler rather than a Server Action, and it has to be**, for the
 * reason `app/api/documents/[file]/route.ts` gives: a Server Action's return
 * value is RSC-serialized, and there is no way to attach `Content-Type` and
 * `Content-Disposition` to it, which is the entire job here.
 *
 * Under `/api/` deliberately, so `proxy.ts`'s redirect→401 conversion applies:
 * without it an unauthenticated `fetch` would follow a 307 to the sign-in page
 * and receive an HTML document with a success status, unable to tell it was
 * refused.
 *
 * The path segment is the Posting id alone — no extension, because a letter has
 * exactly one (`.md`, fixed by `cover-letter-store.ts`) and a URL that lets the
 * caller choose one would be a URL that suggests they can.
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
  const caller = await requireUser(getCurrentUser, "cover-letters")

  if (!caller.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { postingId } = await params

  // ⚠️ **The session's userId, never anything from the URL.** The caller
  // supplies the last segment of the key and nothing else, so a request naming
  // another user's letter cannot be spelled at all.
  const letter = await downloadCoverLetter(
    caller.userId,
    postingId,
    getCoverLetterStore()
  )

  // The status→code mapping and every header live in
  // `postingDocumentResponse`, shared with the tailored-resume route.
  return postingDocumentResponse(letter)
}
