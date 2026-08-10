import { EXTENSION_SOURCE } from "@workspace/user-storage/keys"

/**
 * Addressing a stored document: the two halves of its key, and the single
 * string the download route carries them in.
 *
 * Imports nothing from Next, for the same reason `upload-validation.ts` and
 * `content-disposition.ts` do not — a test can reach it directly. Its one
 * import is the extension pattern from `@workspace/user-storage`, which is a
 * pure module and is the point of the paragraph on {@link EXTENSION_SOURCE}
 * there. But the reason this file is *shared* is separate. These patterns were
 * written twice,
 * once as a combined `FILE_PATTERN` in `app/api/documents/[file]/route.ts` and
 * once as Zod schemas in `document-actions.ts`, along with the same paragraph
 * explaining them; the composite was formatted in a third place,
 * `list-documents.ts`, and parsed only in the route. Two copies of a rule that
 * has to be tightened in lockstep is how the bug they were tightened to fix
 * reached two call sites at once, and the next caller — a replace action, a
 * presigned URL, a bulk delete — would have started from the loose form again.
 */

/**
 * The id half: the 8-4-4-4-12 hex shape `crypto.randomUUID()` produces.
 *
 * Deliberately not "36 characters of `[0-9a-f-]`", and the difference is not
 * pedantry. The loose form admits ids that `assertSegment` in
 * `@workspace/user-storage` rejects — anything not starting and ending
 * alphanumeric, such as a leading dash — so a malformed id could pass the check
 * at the edge and fail deep in the store instead, surfacing as a 500 for what
 * is really a malformed request, or as a message about storing a file on a path
 * where nothing is being stored. This shape makes every id that reaches the
 * store a valid key segment by construction.
 *
 * Also deliberately *not* the stricter RFC 4122 v4 pattern
 * (`…-4xxx-[89ab]xxx-…`, which zod exposes as `z.regexes.uuid4`). The property
 * being enforced is "this is a legal key segment", which the version and
 * variant nibbles have nothing to do with; pinning them would buy no safety and
 * would turn a document undeletable if its id were ever minted by something
 * other than `crypto.randomUUID()`.
 */
const DOCUMENT_ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/**
 * The extension half, including its dot, lowercase — see `extensionOf`.
 *
 * Taken from `@workspace/user-storage` rather than restated. This file already
 * reasons about staying in step with `assertSegment` over in that package for
 * the id half; the extension half used to be the part that was *not*
 * single-sourced, and the two copies had already drifted to different length
 * bounds. Importing the source string is what makes them one fact.
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
