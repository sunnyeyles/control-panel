import { isUserStorageError } from "@workspace/user-storage"

/** Conflated not_found / ownership — never say which. */
export const DOCUMENT_GONE = "That document no longer exists."

export const STORAGE_UNAVAILABLE =
  "Document storage is unavailable. Try again in a moment."

/**
 * A storage failure as something safe to show.
 *
 * Branches on `code`, never `instanceof`, for the reason `errors.ts` states: an
 * error crossing a bundler or package boundary can fail a prototype check while
 * carrying a perfectly good discriminant. Detail goes to the server log alone —
 * callers pass a `logLabel` that names the domain and operation
 * (`documents: upload failed`).
 *
 * `invalidObjectKey` is optional because only some call sites reach that code
 * with user-actionable copy (document upload/delete). Everywhere else it falls
 * through to the generic message.
 */
export function storageMessage(
  logLabel: string,
  error: unknown,
  options?: {
    invalidObjectKey?: string
  }
): string {
  console.error(logLabel, error)

  if (!isUserStorageError(error)) return "Something went wrong."

  switch (error.code) {
    case "invalid_object_key":
      return options?.invalidObjectKey ?? "Something went wrong."

    case "object_not_found":
    case "object_ownership":
      return DOCUMENT_GONE

    case "storage_unavailable":
      return STORAGE_UNAVAILABLE

    default:
      return "Something went wrong."
  }
}
