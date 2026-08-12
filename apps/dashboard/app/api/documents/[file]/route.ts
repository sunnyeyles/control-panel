import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser } from "@/lib/auth/current-user"
import { getPrisma } from "@/lib/db"
import { contentDisposition } from "@/lib/documents/content-disposition"
import { parseDocumentFile } from "@/lib/documents/document-ref"
import { getResumeStore } from "@/lib/storage"
import { findDocument } from "@workspace/db"
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> }
): Promise<Response> {
  // ⚠️ Before the params are read, and "not signed in" answers identically to
  // "not on the allowlist" — telling them apart would confirm to an unapproved
  // caller that their account exists. `requireUser` makes that conflation once;
  // the 401 stays here because a route answers with a `Response`.
  const caller = await requireUser(getCurrentUser, "documents")

  if (!caller.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { file } = await params
  const ref = parseDocumentFile(file)

  if (!ref) return notFound()

  const { documentId, extension } = ref

  // The row before the bytes, for two reasons. It is the ownership check —
  // `findDocument` filters on `userId` as well as `id`, so another user's
  // document is simply not found, with the same 404 as one that does not exist.
  // And it carries the filename, which is what the download is named after:
  // `documents.filename` is the user's own text, where the copy stamped on the
  // object was stripped to printable ASCII on the way in.
  let document
  try {
    document = await findDocument(getPrisma(), caller.userId, documentId)
  } catch (error) {
    console.error("documents: download could not read the row", error)
    return Response.json({ error: "Download failed" }, { status: 500 })
  }

  if (!document || document.extension !== extension) return notFound()

  let stored
  try {
    stored = await getResumeStore().get({
      // The session's userId, never anything from the URL. Ownership is
      // therefore **structural**: a caller cannot construct a request that
      // names another user's object at all, so `assertOwnedBy` inside the store
      // is a second line of defence rather than the only one.
      userId: caller.userId,
      // `ResumeStore`'s field name, not ours — see `NAMING.md` § Known exceptions.
      resumeId: documentId,
      extension,
    })
  } catch (error) {
    console.error("documents: download failed", error)

    if (isUserStorageError(error)) {
      // ⚠️ `object_not_found` and `object_ownership` answer 404 with the same
      // body: distinguishing them makes this route an oracle for whether
      // another user's document id exists. `invalid_object_key` joins them
      // because a key that cannot name an object is, from the caller's side,
      // indistinguishable from one that is not there — and a 500 would report a
      // malformed request as a server fault, filling the log with alarms anyone
      // can trigger from the address bar.
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
      // From the row, not from the object's metadata. The two can differ: the
      // metadata copy is stripped to printable ASCII because it travels as an
      // HTTP header, so `Lebenslauf – 2026.pdf` is stored as
      // `Lebenslauf  2026.pdf` on the object and intact in Postgres.
      // `contentDisposition` is what makes the intact one safe to send back.
      "Content-Disposition": contentDisposition(document.filename),
      // ⚠️ These bytes arrived from outside. A browser that sniffs an uploaded
      // file as HTML and renders it on this origin runs it with the session
      // cookie attached — which is what makes `kinds.ts`'s `attachment`
      // disposition load-bearing here, and why `nosniff` sits beside it.
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
