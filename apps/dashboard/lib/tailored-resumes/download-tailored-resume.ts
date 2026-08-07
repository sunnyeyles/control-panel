import { isPostingId } from "@/lib/cover-letters/cover-letter-ref"
import { tailoredResumeFilename } from "@/lib/tailored-resumes/tailored-resume-ref"
import {
  isUserStorageError,
  type TailoredResumeStore,
} from "@workspace/user-storage"

/**
 * Fetching one stored tailored resume, as a plain function over an injected
 * store.
 *
 * **Nothing here imports Next**, which is the point: the property worth testing
 * is that the object addressed is the *caller's* and can be nothing else, and a
 * session is exactly what a unit test cannot produce. The Next-aware half is
 * `app/api/tailored-resumes/[postingId]/route.ts`, which resolves the session,
 * calls this, and turns the result into a `Response`.
 *
 * ⚠️ **Two things fetch through here, not one.** The route serves a `.md`
 * download, and the PDF button in the detail panel fetches the same URL to hand
 * the markdown to `exportMarkdownToPdf` in the browser. That is why the filename
 * comes back beside the bytes rather than being the route's business: the PDF is
 * named by swapping this one's extension, so the two downloads cannot end up
 * called different things.
 */

/**
 * What the route has to answer with.
 *
 * `not-found` covers "no such resume", "someone else's" and "not an address at
 * all", conflated **deliberately** rather than accidentally. Splitting them
 * would turn this route into an oracle for whether another user's Posting id
 * exists.
 */
export type TailoredResumeDownload =
  | { status: "ok"; markdown: string; filename: string }
  | { status: "not-found" }
  | { status: "failed" }

/**
 * The resume this user generated for this Posting.
 *
 * ⚠️ **`userId` is the session's, and `postingId` is the URL's — never the
 * other way round.** Ownership is therefore *structural*: there is no way to
 * spell a request that names another user's object, because the only thing a
 * caller supplies is the last segment of the key. The ownership assertion inside
 * `@workspace/user-storage` is a second line of defence rather than the only one.
 *
 * The shape check on `postingId` comes first, before the store is touched at
 * all. A value the store would refuse cannot name an object, which from the
 * caller's side is indistinguishable from an object that is not there — and
 * answering "failed" would report a malformed URL as a server fault and fill the
 * log with alarms anyone can trigger from the address bar.
 */
export async function downloadTailoredResume(
  userId: string,
  postingId: string,
  resumes: TailoredResumeStore
): Promise<TailoredResumeDownload> {
  if (!isPostingId(postingId)) return { status: "not-found" }

  let stored
  try {
    stored = await resumes.get({ userId, postingId })
  } catch (error) {
    console.error("tailored-resumes: download failed", error)

    if (isUserStorageError(error)) {
      if (
        error.code === "object_not_found" ||
        error.code === "object_ownership" ||
        error.code === "invalid_object_key"
      ) {
        return { status: "not-found" }
      }
    }

    return { status: "failed" }
  }

  // `get()` fills this in; a resume with no body is one that was stored wrong,
  // and handing back an empty file would look like a successful download of an
  // empty document.
  if (!stored.markdown) {
    console.error("tailored-resumes: download returned no markdown", stored.key)
    return { status: "failed" }
  }

  return {
    status: "ok",
    markdown: stored.markdown,
    filename: tailoredResumeFilename({
      postingId,
      ...(stored.provenance.title ? { title: stored.provenance.title } : {}),
      ...(stored.provenance.company
        ? { company: stored.provenance.company }
        : {}),
    }),
  }
}
