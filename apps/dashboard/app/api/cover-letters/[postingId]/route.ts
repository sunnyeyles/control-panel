import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser } from "@/lib/auth/current-user"
import { downloadCoverLetter } from "@/lib/cover-letters/download-cover-letter"
import { contentDisposition } from "@/lib/documents/content-disposition"
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

  if (letter.status === "not-found") {
    return Response.json({ error: "Not found" }, { status: 404 })
  }

  if (letter.status === "failed") {
    return Response.json({ error: "Download failed" }, { status: 500 })
  }

  return new Response(letter.markdown, {
    headers: {
      // The kind is stored `inline` because these bytes were written by this
      // application rather than uploaded — but a *download* is what this route
      // is for, so `contentDisposition()` (which always emits `attachment`) is
      // reused rather than restated. It also does the header escaping, which is
      // the half worth not writing twice.
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": contentDisposition(letter.filename),
      // Belt-and-braces beside a Markdown body: this is not an upload, so the
      // stored-XSS argument that makes documents an attachment does not apply
      // here — but a browser that sniffs a letter as HTML would still run it on
      // this origin with the session cookie attached.
      "X-Content-Type-Options": "nosniff",
      // Personal data behind a CDN. `private` keeps it out of shared caches;
      // `no-store` keeps it out of the browser's disk cache on a shared machine.
      "Cache-Control": "private, no-store",
    },
  })
}
