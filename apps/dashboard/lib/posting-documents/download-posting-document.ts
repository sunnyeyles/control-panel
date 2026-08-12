import { isUserStorageError } from "@workspace/user-storage"

import { postingDocumentFilename } from "./posting-document-filename"
import { isPostingId } from "./posting-document-ref"

/**
 * Fetching one stored **Posting Document** for download.
 *
 * **Nothing here imports Next**, which is what makes this testable: the property
 * worth asserting is that the object addressed is the *caller's* and can be
 * nothing else, and a session is what a unit test cannot produce. The Next-aware
 * halves are the two routes under `app/api/`, which transitively import the auth
 * SDK — so anything left inside them is untestable.
 *
 * ⚠️ **Two things fetch through here, not one.** A route serves the `.md`, and
 * the PDF button fetches the same URL to hand the markdown to
 * `exportMarkdownToPdf` in the browser. That is why the filename comes back
 * beside the bytes: the PDF is named by swapping this one's extension, so the
 * two downloads cannot end up called different things.
 */

/**
 * What the route has to answer with.
 *
 * ⚠️ `not-found` conflates "no such document", "someone else's" and "not an
 * address at all" **deliberately**: splitting them would turn the route into an
 * oracle for whether another user's Posting id exists.
 */
export type PostingDocumentDownload =
  | { status: "ok"; markdown: string; filename: string }
  | { status: "not-found" }
  | { status: "failed" }

/**
 * The one method this needs, stated structurally.
 *
 * Both facades satisfy it without being named, which is what lets one function
 * serve both without `@workspace/user-storage` growing a shared supertype it has
 * no other use for.
 */
export interface DownloadablePostingDocuments {
  get(ref: { userId: string; postingId: string }): Promise<{
    key: string
    markdown?: string | undefined
    provenance: { title?: string | undefined; company?: string | undefined }
  }>
}

export interface PostingDocumentDownloadOptions {
  /** The object kind, for the server-side log line only. */
  kind: string
  /** What the file is called, before the Posting's own details. */
  label: string
}

/**
 * The document this user has for this Posting.
 *
 * ⚠️ **The key is built from the session's user id.** A caller supplies only the
 * last segment, so they cannot spell a request naming another user's object; the
 * ownership assertion in `@workspace/user-storage` is a second line, not the only
 * one.
 *
 * The shape check comes first, before the store is touched: answering "failed"
 * would report a malformed URL as a server fault and fill the log with alarms
 * anyone can trigger from the address bar.
 */
export async function downloadPostingDocument(
  userId: string,
  postingId: string,
  documents: DownloadablePostingDocuments,
  { kind, label }: PostingDocumentDownloadOptions
): Promise<PostingDocumentDownload> {
  if (!isPostingId(postingId)) return { status: "not-found" }

  let stored
  try {
    stored = await documents.get({ userId, postingId })
  } catch (error) {
    console.error(`${kind}: download failed`, error)

    if (
      isUserStorageError(error) &&
      (error.code === "object_not_found" ||
        error.code === "object_ownership" ||
        error.code === "invalid_object_key")
    ) {
      return { status: "not-found" }
    }

    return { status: "failed" }
  }

  // `get()` fills this in; a document with no body is one that was stored wrong,
  // and handing back an empty file would look like a successful download of an
  // empty document.
  if (!stored.markdown) {
    console.error(`${kind}: download returned no markdown`, stored.key)
    return { status: "failed" }
  }

  return {
    status: "ok",
    markdown: stored.markdown,
    filename: postingDocumentFilename(label, {
      postingId,
      ...(stored.provenance.title ? { title: stored.provenance.title } : {}),
      ...(stored.provenance.company
        ? { company: stored.provenance.company }
        : {}),
    }),
  }
}
