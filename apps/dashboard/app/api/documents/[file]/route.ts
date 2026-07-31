import { getCurrentUser } from "@/lib/auth/current-user"
import { contentDisposition } from "@/lib/documents/content-disposition"
import { getResumeStore } from "@/lib/storage"
import { isUserStorageError } from "@workspace/user-storage"

/**
 * Download one document.
 *
 * **A Route Handler rather than a Server Action, and it has to be.** A Server
 * Action's return value is RSC-serialized; there is no way to attach
 * `Content-Type` and `Content-Disposition` to it, which is the entire job here.
 *
 * Under `/api/` deliberately, so `proxy.ts`'s redirect→401 conversion applies:
 * without it an unauthenticated `fetch` would follow a 307 to the sign-in page
 * and receive an HTML document with a success status, unable to tell it was
 * refused.
 *
 * Unlike the upload path, both gate layers work as designed here — the auth
 * SDK's session fast path is guarded by `method === "GET"`, and this is a GET.
 * The check below is still the authoritative one.
 */

/** Required of anything reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * `{resumeId}{extension}`, e.g. `…-….pdf`.
 *
 * The id half is the full v4 uuid shape rather than "36 characters of
 * `[0-9a-f-]`", and the difference is not pedantry. The loose form admits ids
 * that `assertSegment` in `@workspace/user-storage` rejects — anything not
 * starting and ending alphanumeric, such as a leading dash — so a request could
 * pass the check here and fail deep in the store, arriving as a 500 for what is
 * really a malformed request. Matching what `crypto.randomUUID()` actually
 * produces makes every id that reaches the store a valid key segment by
 * construction, and no id this app has ever written fails it.
 */
const FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]{1,10})$/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> }
): Promise<Response> {
  // Before the params are even read. An unauthenticated caller learns nothing
  // about what a well-formed request looks like, and both "not signed in" and
  // "not on the allowlist" answer identically — telling them apart would
  // confirm to an unapproved caller that their account exists.
  let user
  try {
    user = await getCurrentUser()
  } catch (error) {
    console.error("documents: failed to resolve the caller", error)
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (user.status !== "ok") {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { file } = await params
  const match = FILE_PATTERN.exec(file)

  if (!match) return notFound()

  const [, resumeId, extension] = match
  if (!resumeId || !extension) return notFound()

  let stored
  try {
    stored = await getResumeStore().get({
      // The session's userId, never anything from the URL. Ownership is
      // therefore **structural**: a caller cannot construct a request that
      // names another user's object at all, so `assertOwnedBy` inside the store
      // is a second line of defence rather than the only one.
      userId: user.userId,
      resumeId,
      extension,
    })
  } catch (error) {
    console.error("documents: download failed", error)

    if (isUserStorageError(error)) {
      // `object_not_found` and `object_ownership` both answer 404 with the same
      // body. Distinguishing them would turn this route into an oracle for
      // whether another user's document id exists — which is exactly what
      // `errors.ts` warns about, and the reason the store bothers to have two
      // error types rather than the caller having two responses.
      //
      // `invalid_object_key` joins them, for a different reason: a key the
      // store will not address is one that cannot name an object, which from
      // the caller's side is indistinguishable from an object that is not
      // there. `FILE_PATTERN` should already have caught every such id, so this
      // is the second line rather than the first — but answering 500 would
      // report a malformed request as a server fault and fill the log with
      // alarms anyone can trigger from the address bar.
      if (
        error.code === "object_not_found" ||
        error.code === "object_ownership" ||
        error.code === "invalid_object_key"
      ) {
        return notFound()
      }
    }

    return Response.json({ error: "Download failed" }, { status: 500 })
  }

  if (!stored.bytes) {
    console.error("documents: download returned no bytes", stored.key)
    return Response.json({ error: "Download failed" }, { status: 500 })
  }

  // Buffered, not streamed. `ResumeStore.get()` returns a `Uint8Array` — the
  // facade has already collected the whole body — so nothing here could stream
  // even if it wanted to. Fine at a 3 MiB ceiling; if that ceiling ever rises
  // substantially, this is the line that has to change first.
  return new Response(new Uint8Array(stored.bytes), {
    headers: {
      "Content-Type": stored.contentType,
      "Content-Length": String(stored.bytes.byteLength),
      "Content-Disposition": contentDisposition(
        stored.originalFilename ?? `${resumeId}${extension}`
      ),
      // These bytes arrived from outside. `kinds.ts` calls the `attachment`
      // disposition the stored-XSS guard and notes it was belt-and-braces while
      // nothing served uploaded bytes to a browser — this route is what makes
      // it load-bearing, so `nosniff` belongs beside it. A browser that sniffs
      // an uploaded file as HTML and renders it on this origin runs it with the
      // session cookie attached.
      "X-Content-Type-Options": "nosniff",
      // Personal data behind a CDN. `private` keeps it out of shared caches;
      // `no-store` keeps it out of the browser's disk cache on a shared machine.
      "Cache-Control": "private, no-store",
    },
  })
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 })
}
