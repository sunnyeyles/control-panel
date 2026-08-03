import { isUserStorageError } from "@workspace/user-storage"

/**
 * A storage failure as something safe to show, and a server log line that says
 * more than the user is told.
 *
 * It existed twice before this module — `lib/documents/document-actions.ts` and
 * `lib/cover-letters/cover-letter-actions.ts` — with the same log call, the same
 * `isUserStorageError` guard, the same switch, and the same three sentences. The
 * only thing that ever differed was the copy for `invalid_object_key`, which is
 * why that is the one thing a caller passes in.
 *
 * Nothing here imports Next, like the rest of `lib/actions/`, so the actions
 * that use it stay coverable by Vitest.
 */

/**
 * One sentence for "no such object" and "someone else's object".
 *
 * Identical **on purpose**, and the reason is the same one `errors.ts` gives for
 * having two error types in the first place: a caller that must not learn
 * whether an object exists conflates them, and the conflation should be visible
 * where it is made. Splitting these would turn a delete form into an oracle for
 * whether another user's document id is real.
 *
 * Worded for documents because that is what both call sites store — an uploaded
 * CV, a drafted letter — and a user has no vocabulary for "object".
 */
export const OBJECT_GONE = "That document no longer exists."

/**
 * Where `AccessDenied` lands, which matters more for diagnosis than for the
 * user: a broken IAM attachment or a mismatched OIDC subject surfaces here as a
 * transient-sounding message rather than as a 404. If this appears consistently
 * on a fresh deploy, read the function logs — the cause is in the
 * AssumeRoleWithWebIdentity call, not in this app.
 */
export const STORAGE_UNAVAILABLE =
  "Document storage is unavailable. Try again in a moment."

/** Anything this module cannot say something more useful about. */
export const UNKNOWN_FAILURE = "Something went wrong."

export interface StorageMessageOptions {
  /**
   * Prefixes the server log line — `"documents"`, `"cover-letters"`. Never
   * reaches the client.
   */
  domain: string
  /**
   * The verb in the log line — `"upload"`, `"delete"`, `"read"`, `"write"`.
   * Never reaches the client either; a branch that needs to turn on it should
   * do so by choosing what to pass as {@link StorageMessageOptions.invalidKey}.
   */
  operation: string
  /** The unknown catch binding, narrowed here rather than by the caller. */
  error: unknown
  /**
   * What to say for `invalid_object_key`, or nothing to treat it as an
   * unexplained failure.
   *
   * Required of a caller that can actually *reach* the case, and deliberately
   * absent from one that cannot. On an upload it is reachable and the advice is
   * real — `cleanFilename` in the resume store throws when a filename has no
   * representable ASCII left, which the upload check does not catch because the
   * extension is fine, so "check the file name" is something the user can act
   * on with the file in front of them. On a delete there is no file and no name
   * to check, so the honest answer is {@link OBJECT_GONE}: the row is
   * unaddressable, which is the same thing as gone as far as anyone can act on
   * it.
   */
  invalidKey?: string
}

/**
 * Branches on `code`, never `instanceof` — `errors.ts` says so explicitly, and
 * the reason is real: an error crossing a bundler or package boundary can fail
 * a prototype check while carrying a perfectly good discriminant.
 *
 * Detail goes to the server log and nowhere else, matching `chat-handler.ts`.
 */
export function storageMessage(options: StorageMessageOptions): string {
  const { domain, operation, error, invalidKey } = options

  console.error(`${domain}: ${operation} failed`, error)

  if (!isUserStorageError(error)) return UNKNOWN_FAILURE

  switch (error.code) {
    case "invalid_object_key":
      // Falls through to the default when a caller supplied nothing, rather
      // than borrowing OBJECT_GONE. A caller that cannot reach this case has no
      // sentence for it, and inventing one on its behalf would tell a user an
      // object is gone on a path where nothing was addressed at all.
      return invalidKey ?? UNKNOWN_FAILURE

    case "object_not_found":
    case "object_ownership":
      return OBJECT_GONE

    case "storage_unavailable":
      return STORAGE_UNAVAILABLE

    default:
      return UNKNOWN_FAILURE
  }
}
