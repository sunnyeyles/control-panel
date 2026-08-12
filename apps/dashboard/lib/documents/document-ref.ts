import { EXTENSION_SOURCE } from "@workspace/user-storage/keys"

/**
 * Addressing a stored document: the two halves of its key, and the single
 * string the download route carries them in.
 *
 * Imports nothing from Next, for the reason `upload-validation.ts` does not — a
 * test can reach it directly.
 *
 * ⚠️ Shared because these patterns were written twice, in the download route and
 * in `document-actions.ts`, and formatted in a third place. Two copies of a rule
 * that must be tightened in lockstep is how the bug they were tightened to fix
 * reached two call sites at once.
 */

/**
 * The id half: the 8-4-4-4-12 hex shape `crypto.randomUUID()` produces.
 *
 * ⚠️ Deliberately not "36 characters of `[0-9a-f-]`": the loose form admits ids
 * `assertSegment` rejects (a leading dash), so a malformed id would pass at the
 * edge and fail deep in the store as a 500. This shape makes every id reaching
 * the store a valid key segment by construction.
 *
 * Also deliberately *not* the stricter RFC 4122 v4 pattern. The property
 * enforced is "legal key segment", which the version and variant nibbles have
 * nothing to do with; pinning them would make a document undeletable if its id
 * were ever minted by something other than `crypto.randomUUID()`.
 */
const DOCUMENT_ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/**
 * The extension half, including its dot, lowercase — see `extensionOf`.
 *
 * Taken from `@workspace/user-storage` rather than restated — the two copies had
 * already drifted to different length bounds.
 *
 * The subpath, not the barrel: `keys.ts` imports only `errors.ts` and
 * `kinds.ts`, so nothing here pulls in the AWS SDK.
 */
const EXTENSION = EXTENSION_SOURCE

export const DOCUMENT_ID_PATTERN = new RegExp(`^${DOCUMENT_ID}$`)

const FILE_PATTERN = new RegExp(`^(${DOCUMENT_ID})(${EXTENSION})$`)

/** The two halves of a stored object's address. */
export interface DocumentRef {
  documentId: string
  extension: string
}

/**
 * The form the download route's path segment takes, e.g. `…-….pdf`.
 *
 * Formatting lives beside {@link parseDocumentFile} so the round trip is one
 * decision. They were in different modules, which is the arrangement where a
 * change to one silently stops matching the other.
 */
export function formatDocumentFile(ref: DocumentRef): string {
  return `${ref.documentId}${ref.extension}`
}

/** The inverse, or `undefined` for anything this app did not write. */
export function parseDocumentFile(file: string): DocumentRef | undefined {
  const match = FILE_PATTERN.exec(file)

  if (!match) return undefined

  // A match guarantees both groups; `noUncheckedIndexedAccess` types them as
  // optional anyway, so this narrows rather than defends.
  const [, documentId, extension] = match
  if (!documentId || !extension) return undefined

  return { documentId, extension }
}
