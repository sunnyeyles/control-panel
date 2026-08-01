/**
 * Everything about an upload that can be decided without S3, without Next, and
 * without a session.
 *
 * No imports at all, on purpose. The accepted extensions arrive as a parameter
 * rather than being read from `@workspace/user-storage`, so this module's tests
 * need no workspace package built and no environment configured — which is what
 * makes it realistic to test the awkward filename cases exhaustively.
 *
 * The size ceilings live here rather than in `@workspace/user-storage` because
 * they are not a property of the storage. That package validates keys, kinds
 * and content types and states plainly that it does no size validation; the
 * limits below exist because of how *Next* buffers a request body and what
 * Vercel's platform will carry. Moving them into the storage package would put
 * a transport constraint behind an interface that has nothing to do with
 * transport.
 */

/**
 * The largest document a user may upload.
 *
 * Checked against the bytes actually held after reading the file, which is the
 * only number that cannot be lied about — see `MAX_REQUEST_BYTES` for why the
 * declared size is checked too, and why it is not enough on its own.
 */
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024

/**
 * The largest request body, checked against the `content-length` header.
 *
 * Larger than `MAX_DOCUMENT_BYTES` because a multipart body carries boundaries,
 * field names and headers around the file. The gap is generous; this limit is
 * not trying to be precise, it is trying to reject something enormous before
 * the bytes are read into memory.
 *
 * ⚠️ **Used only to reject, never to accept.** `content-length` is
 * client-supplied. Its value in this design is narrow but real: Next's proxy
 * body buffering truncates an oversized body *silently* rather than failing,
 * and a truncated body's parsed `File.size` reports the truncated length — so
 * the file's own size can only ever under-report. The header is not rewritten
 * by truncation, which makes it the one honest witness to how large the request
 * claimed to be. A liar that only ever lies downward is still useful for
 * catching the too-big case.
 *
 * Must stay strictly **below** {@link MAX_ACTION_BODY_BYTES}, or Next refuses
 * the request before the action runs and this check never gets to speak.
 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/**
 * `experimental.serverActions.bodySizeLimit` in `next.config.ts`, which imports
 * this constant rather than restating it.
 *
 * ⚠️ **The gap above `MAX_REQUEST_BYTES` is the whole point of the number.**
 * These two were both 4 MiB, which is not a ladder — it is a tie, and Next won
 * it. Next enforces its own limit on the body as it streams, before the action
 * function is ever called, so at parity the friendly "That upload is too large."
 * was unreachable through the UI and every real oversized upload surfaced as a
 * generic Server Action error instead. A limit whose error message cannot be
 * reached is not a limit, it is a comment.
 *
 * Bounded on the other side by Vercel's ~4.5 MB platform cap, which is enforced
 * before the request reaches Next and which no code here can turn into a
 * friendly message. So this value has to sit strictly between the two.
 *
 * Derived from `MAX_REQUEST_BYTES` rather than written as its own number, so
 * that raising one cannot silently re-create the tie — which is the mistake
 * this constant exists to undo. 128 KiB of headroom is far more than a
 * multipart envelope needs and still leaves ~175 KB under the platform cap.
 * (`4.2 * 1024 * 1024` would have been the obvious literal and is not a whole
 * number of bytes.)
 */
export const MAX_ACTION_BODY_BYTES = MAX_REQUEST_BYTES + 128 * 1024

/**
 * `experimental.proxyClientMaxBodySize` in `next.config.ts` — the top rung.
 *
 * Here for the same reason as the rung below it. Deriving the action limit from
 * `MAX_REQUEST_BYTES` fixed one tie and left this one written out as `"6mb"` in
 * a different file, in a different unit, related to the others only by prose —
 * which is exactly the arrangement that produced the tie in the first place.
 * Raising `MAX_REQUEST_BYTES` past ~5.87 MiB would have silently inverted the
 * pair `next.config.ts` warns loudest about, with nothing failing.
 *
 * The gap is generous because this rung is not a limit anyone should reach:
 * exceeding it truncates the buffered body *without failing the request*, so
 * the design is for the action limit to always bind first. See the comment in
 * `next.config.ts` for what truncation would mean.
 */
export const MAX_PROXY_BUFFER_BYTES = MAX_ACTION_BODY_BYTES + 2 * 1024 * 1024

export type UploadRejection =
  | { reason: "empty-filename" }
  | { reason: "no-extension"; filename: string }
  | { reason: "unsupported-extension"; extension: string; accepted: string[] }
  | { reason: "empty-file" }
  | { reason: "too-large"; byteLength: number }

export interface UploadCandidate {
  filename: string
  byteLength: number
}

/**
 * The dot-prefixed, lowercased extension of a filename, or undefined.
 *
 * Deliberately takes the **last** dot, so `cv.pdf.exe` is `.exe` rather than
 * `.pdf`. A double extension is the oldest trick for getting an executable past
 * a filter that stops at the first dot it finds.
 *
 * Returns undefined for a name with no dot, a name ending in a dot, and a name
 * that is nothing but an extension (`.pdf`) — the last because such a name has
 * no basename, and it is far more likely to be a dotfile or a mangled upload
 * than a document someone meant to send.
 */
export function extensionOf(filename: string): string | undefined {
  const trimmed = filename.trim()
  const dot = trimmed.lastIndexOf(".")

  if (dot <= 0) return undefined
  if (dot === trimmed.length - 1) return undefined

  return trimmed.slice(dot).toLowerCase()
}

/**
 * Whether an upload may proceed.
 *
 * `accepted` is the kind's allowlist — pass `acceptedResumeExtensions()`. It is
 * a parameter so this module stays dependency-free; the coupling is checked by
 * the caller's own test rather than by an import.
 */
export function checkUpload(
  candidate: UploadCandidate,
  accepted: readonly string[]
): { ok: true; extension: string } | { ok: false; rejection: UploadRejection } {
  const filename = candidate.filename.trim()

  if (!filename) {
    return { ok: false, rejection: { reason: "empty-filename" } }
  }

  const extension = extensionOf(filename)
  if (!extension) {
    return { ok: false, rejection: { reason: "no-extension", filename } }
  }

  if (!accepted.includes(extension)) {
    return {
      ok: false,
      rejection: {
        reason: "unsupported-extension",
        extension,
        accepted: [...accepted],
      },
    }
  }

  // Before the size check, not after: an empty file is a mistake rather than a
  // policy violation, and "that file is empty" is more useful than nothing.
  if (candidate.byteLength <= 0) {
    return { ok: false, rejection: { reason: "empty-file" } }
  }

  if (candidate.byteLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      rejection: { reason: "too-large", byteLength: candidate.byteLength },
    }
  }

  return { ok: true, extension }
}

/**
 * A rejection as something to show a person.
 *
 * Every branch says what to do next. These are the user's own files and their
 * own mistakes, so there is nothing to withhold — unlike the storage errors in
 * `document-actions.ts`, where the message is deliberately vague because the
 * detail would disclose whether an object exists.
 */
export function describeRejection(rejection: UploadRejection): string {
  switch (rejection.reason) {
    case "empty-filename":
      return "That file has no name. Rename it and try again."
    case "no-extension":
      return `“${rejection.filename}” has no file extension, so there is no way to tell what it is.`
    case "unsupported-extension":
      return `${rejection.extension} files are not supported. Try ${formatList(rejection.accepted)}.`
    case "empty-file":
      return "That file is empty."
    case "too-large":
      return `That file is ${formatBytes(rejection.byteLength)}. The limit is ${formatBytes(MAX_DOCUMENT_BYTES)}.`
  }
}

function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""

  const head = items.slice(0, -1).join(", ")
  return `${head} or ${items[items.length - 1]}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`

  // One decimal place, because the difference between "3 MB" and "3 MB" either
  // side of the limit reads as the app being broken.
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
