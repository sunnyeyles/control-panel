import {
  coverLetterFilename,
  isPostingId,
} from "@/lib/cover-letters/cover-letter-ref"
import {
  isMissingObjectError,
  type CoverLetterStore,
} from "@workspace/user-storage"

/**
 * Fetching one stored letter for download, as a plain function over an injected
 * store.
 *
 * **Nothing here imports Next**, which is the point: the property worth testing
 * is that the object addressed is the *caller's* letter and can be nothing else,
 * and a session is exactly what a unit test cannot produce. The Next-aware half
 * is `app/api/cover-letters/[postingId]/route.ts`, which resolves the session,
 * calls this, and turns the result into a `Response` with the headers that make
 * it a download.
 *
 * The split is the one `lib/documents/content-disposition.ts` made for the
 * documents route and for the same reason — the route transitively imports the
 * auth SDK, so anything left inside it is untestable.
 */

/**
 * What the route has to answer with.
 *
 * `not-found` covers "no such letter", "someone else's letter" and "not a
 * letter address at all", conflated **deliberately** rather than accidentally.
 * Splitting them would turn this route into an oracle for whether another
 * user's Posting id exists — the same reasoning `errors.ts` gives for having two
 * error types and the download route for documents gives for having one
 * response.
 */
export type CoverLetterDownload =
  | { status: "ok"; markdown: string; filename: string }
  | { status: "not-found" }
  | { status: "failed" }

/**
 * The letter this user drafted for this Posting.
 *
 * ⚠️ **`userId` is the session's, and `postingId` is the URL's — never the
 * other way round.** Ownership is therefore *structural*: there is no way to
 * spell a request that names another user's object, because the only thing a
 * caller supplies is the last segment of the key. The ownership assertion inside
 * `@workspace/user-storage` is a second line of defence rather than the only
 * one, and `download-cover-letter.test.ts` is what pins that.
 *
 * The shape check on `postingId` comes first, before the store is touched at
 * all. A value the store would refuse cannot name an object, which from the
 * caller's side is indistinguishable from an object that is not there — and
 * answering "failed" would report a malformed URL as a server fault and fill the
 * log with alarms anyone can trigger from the address bar.
 */
export async function downloadCoverLetter(
  userId: string,
  postingId: string,
  letters: CoverLetterStore
): Promise<CoverLetterDownload> {
  if (!isPostingId(postingId)) return { status: "not-found" }

  let stored
  try {
    stored = await letters.get({ userId, postingId })
  } catch (error) {
    console.error("cover-letters: download failed", error)

    // The three codes that mean "nothing here you may have" are conflated by
    // `isMissingObjectError` in `@workspace/user-storage`, which is where the
    // reasoning lives — it is a rule about what not to reveal, and it was
    // written out identically here, in the documents route, and in the two
    // action modules.
    if (isMissingObjectError(error)) return { status: "not-found" }

    return { status: "failed" }
  }

  // `get()` fills this in; a letter with no body is a letter that was stored
  // wrong, and handing back an empty file would look like a successful download
  // of an empty draft.
  if (!stored.markdown) {
    console.error("cover-letters: download returned no markdown", stored.key)
    return { status: "failed" }
  }

  return {
    status: "ok",
    markdown: stored.markdown,
    filename: coverLetterFilename({
      postingId,
      ...(stored.provenance.title ? { title: stored.provenance.title } : {}),
      ...(stored.provenance.company
        ? { company: stored.provenance.company }
        : {}),
    }),
  }
}
