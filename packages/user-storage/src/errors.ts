/**
 * Every failure this package raises, as one closed set.
 *
 * The `code` discriminant is the part callers should branch on. `instanceof`
 * works too, but it breaks the moment two copies of this package end up in a
 * dependency graph, and a bundled worker is exactly where that happens — so
 * the string is the contract and the classes are a convenience.
 */
export type UserStorageErrorCode =
  | "invalid_object_key"
  | "object_not_found"
  | "object_ownership"
  | "storage_unavailable"

/** Base for everything below. Never thrown directly. */
export abstract class UserStorageError extends Error {
  abstract readonly code: UserStorageErrorCode

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * A key, one of the parts a key is built from, or a file type is not valid.
 *
 * This is the load-bearing one. Identifiers become path segments, so an
 * unvalidated `userId` of `../someone-else` would address another user's
 * prefix — the key layout *is* the ownership boundary, and this error is what
 * stops a caller from stepping over it. It also covers a file extension the
 * kind does not accept, which is what keeps an arbitrary upload from being
 * stored under a media type the caller chose.
 */
export class InvalidObjectKeyError extends UserStorageError {
  readonly code = "invalid_object_key" as const
}

/** No object at the key — including one whose latest version is a delete marker. */
export class ObjectNotFoundError extends UserStorageError {
  readonly code = "object_not_found" as const

  constructor(
    readonly key: string,
    options?: { cause?: unknown }
  ) {
    super(`Nothing stored at "${key}".`, options)
  }
}

/**
 * The object exists but belongs to someone else.
 *
 * Distinct from {@link ObjectNotFoundError} on purpose so the two can be
 * conflated deliberately rather than accidentally: a caller that must not leak
 * existence should catch this and rethrow a not-found, and the choice is then
 * visible at the call site instead of buried here.
 */
export class ObjectOwnershipError extends UserStorageError {
  readonly code = "object_ownership" as const

  constructor(
    readonly key: string,
    readonly expectedUserId: string,
    readonly actualUserId: string | undefined
  ) {
    super(
      `Object "${key}" belongs to ${actualUserId ? `"${actualUserId}"` : "an unknown user"}, not "${expectedUserId}".`
    )
  }
}

/**
 * The storage backend refused or could not be reached.
 *
 * Wraps transport, permission, and throttling faults alike. The distinction
 * that matters to a caller is "the object is wrong" versus "the store is", and
 * this is the second one; `cause` carries the SDK error for logging.
 */
export class StorageUnavailableError extends UserStorageError {
  readonly code = "storage_unavailable" as const
}

/** Narrows an unknown catch binding to this package's errors. */
export function isUserStorageError(error: unknown): error is UserStorageError {
  return error instanceof Error && "code" in error && isErrorCode(error.code)
}

/**
 * Whether a failure means "there is nothing here this caller may have" —
 * {@link ObjectNotFoundError}, {@link ObjectOwnershipError}, or
 * {@link InvalidObjectKeyError}.
 *
 * **The conflation of those three is the point, and it belongs here rather than
 * at each call site.** {@link ObjectOwnershipError} exists precisely so a caller
 * can conflate it with a not-found deliberately, and the download paths must:
 * distinguishing them turns a route into an oracle for whether another user's
 * object id is real. `invalid_object_key` joins them for a different reason — a
 * key the store will not address is one that cannot name an object, which from
 * the caller's side is indistinguishable from an object that is not there, and
 * answering "the server broke" would report a malformed URL as a fault and fill
 * the log with alarms anyone can trigger from the address bar.
 *
 * That reasoning was written out three times, once per call site, as the same
 * three-code disjunction. Three copies of a rule about *what not to reveal* is
 * how one of them comes to reveal it.
 *
 * ⚠️ **Not for the `storage_unavailable` case.** That one is the store being
 * wrong rather than the object, and a caller that folds it in here reports a
 * broken IAM attachment as a 404 — which looks like a user error and hides the
 * only symptom the real fault has.
 */
export function isMissingObjectError(error: unknown): boolean {
  return (
    isUserStorageError(error) &&
    (error.code === "object_not_found" ||
      error.code === "object_ownership" ||
      error.code === "invalid_object_key")
  )
}

function isErrorCode(value: unknown): value is UserStorageErrorCode {
  return (
    value === "invalid_object_key" ||
    value === "object_not_found" ||
    value === "object_ownership" ||
    value === "storage_unavailable"
  )
}
