import type { CurrentUser } from "@/lib/auth/current-user"
import {
  acceptedResumeExtensions,
  isDocumentType,
  isUserStorageError,
  type DocumentType,
  type ResumeStore,
} from "@workspace/user-storage"
import { z } from "zod"

import type { DocumentActionState } from "./action-state"
import {
  checkUpload,
  describeRejection,
  MAX_REQUEST_BYTES,
} from "./upload-validation"

export type { DocumentActionState } from "./action-state"

/**
 * The document actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next.** That is what lets the security
 * branches be tested at all: every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/documents/actions.ts`, which is `"use server"`, supplies the real
 * dependencies, and calls `refresh()` — cache invalidation needs a request
 * store, so it stays there rather than here.
 *
 * The shape mirrors `lib/chat-handler.ts`: a `createXActions(deps)` factory with
 * an injectable `getUser` seam, the auth check before any body handling, and
 * client-facing messages that say less than the server log does.
 */

/**
 * One message for both "not signed in" and "signed in but not allowed".
 *
 * Identical on purpose, and the same choice `lib/chat-handler.ts` makes when it
 * answers 401 rather than 403 for both. Telling the second caller apart from
 * the first confirms to someone outside the allowlist that their account exists
 * and merely is not approved — which is more than they need to know. The
 * *pages* do distinguish them, because by then the user has been identified.
 *
 * Easy to regress by "improving" the copy, and invisible in review, which is
 * why it is one constant with a test asserting both paths produce it.
 */
const NOT_AUTHORIZED = "You are not signed in."

export interface DocumentActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The store, resolved per call rather than held.
   *
   * Called inside the action bodies, never in the factory, so
   * `createDocumentActions(...)` at module scope in the wrapper constructs
   * nothing and cannot throw at import time on a missing bucket name.
   */
  getResumes: () => ResumeStore
  /**
   * The declared size of the request body, or undefined if there was no
   * `content-length`.
   *
   * Required rather than defaulted, because the only real implementation reads
   * Next's request headers and this module must not import Next. Making it
   * optional would mean a caller silently losing the check by forgetting it.
   */
  getContentLength: () => Promise<number | undefined>
  /** Overridden in tests so an assertion can name the key. */
  newResumeId?: () => string
}

/**
 * Shape only. Size and extension go through `checkUpload` so that policy lives
 * in one pure, exhaustively tested function rather than being split between a
 * schema and a function.
 *
 * Note what is absent: any use of `file.type`. The browser-declared MIME type
 * is a caller-supplied claim, and the storage layer derives the content type
 * from the extension against its own allowlist precisely so that claim never
 * matters.
 */
const uploadSchema = z.object({
  file: z.instanceof(File),
  documentType: z.string().optional(),
})

/**
 * The two halves of a stored object's address, validated separately.
 *
 * Both arrive from a hidden form field, so both are untrusted. Neither is
 * trusted to name a *user*, though — see `deleteDocument`.
 *
 * The id is the full v4 uuid shape rather than "36 characters of `[0-9a-f-]`".
 * The loose form admits ids that `assertSegment` in `@workspace/user-storage`
 * rejects — anything not starting and ending alphanumeric — which would take a
 * malformed field past this check and fail it deep in the store instead, where
 * the only message available is about storing a file. Matching what
 * `crypto.randomUUID()` produces keeps the rejection here, where the wording
 * fits.
 */
const resumeIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const extensionSchema = z.string().regex(/^\.[a-z0-9]{1,10}$/)

export function createDocumentActions(deps: DocumentActionsDeps) {
  const newResumeId = deps.newResumeId ?? (() => crypto.randomUUID())

  /**
   * Resolve the caller, or the message to show instead.
   *
   * A thrown error here is treated as "not authorized" rather than propagated:
   * `getCurrentUser` touches the database to map an auth id onto a platform
   * user, and a database blip must not turn into an unauthenticated write.
   *
   * Returns a *message* rather than a finished state so the caller can stamp
   * the carried nonce onto it — see {@link carryNonce}. A refusal is a failure
   * like any other and must not reset the form either.
   */
  async function requireUser(): Promise<
    { ok: true; userId: string } | { ok: false; message: string }
  > {
    let user: CurrentUser

    try {
      user = await deps.getUser()
    } catch (error) {
      console.error("documents: failed to resolve the caller", error)
      return { ok: false, message: NOT_AUTHORIZED }
    }

    if (user.status !== "ok") {
      return { ok: false, message: NOT_AUTHORIZED }
    }

    return { ok: true, userId: user.userId }
  }

  async function uploadDocument(
    state: DocumentActionState,
    formData: FormData
  ): Promise<DocumentActionState> {
    // Every failure below goes through this rather than building its own error
    // state, so the carried nonce cannot be forgotten on one branch out of
    // eight — which is exactly how the form came to reset itself mid-retry.
    const fail = (message: string) => carryNonce(state, message)

    // Before the body is touched at all.
    //
    // Not belt-and-braces here, unlike on a GET. `proxy.ts` cannot evaluate a
    // non-GET request — `@neondatabase/auth`'s session fast path is guarded by
    // `method === "GET"` — so for this POST it degrades to checking that *some*
    // session cookie substring is present. This is the only real check on the
    // path, and Next's own documentation says the same thing: a Server Function
    // is reachable by direct POST, not only through the UI.
    const caller = await requireUser()
    if (!caller.ok) return fail(caller.message)

    // Before `arrayBuffer()`, so the bytes are not copied a second time. Note
    // what this does *not* buy: by the time a Server Action runs, Next has
    // already parsed and buffered the multipart body, so the first copy is
    // unavoidable here — `serverActions.bodySizeLimit` is what caps it. See
    // MAX_REQUEST_BYTES for why a client-supplied header is worth consulting at
    // all, and why only to reject.
    const declared = await deps.getContentLength()
    if (declared !== undefined && declared > MAX_REQUEST_BYTES) {
      return fail("That upload is too large.")
    }

    const parsed = uploadSchema.safeParse({
      file: formData.get("file"),
      documentType: formData.get("documentType") ?? undefined,
    })

    if (!parsed.success) {
      return fail("Choose a file to upload.")
    }

    const { file } = parsed.data

    const bytes = new Uint8Array(await file.arrayBuffer())

    // On the bytes actually held, not on `file.size`. This is the
    // authoritative check — every other size limit in the ladder exists to keep
    // the request from being mangled before it reaches this line.
    const check = checkUpload(
      { filename: file.name, byteLength: bytes.byteLength },
      acceptedResumeExtensions()
    )

    if (!check.ok) {
      return fail(describeRejection(check.rejection))
    }

    // A `<select>` value arrives in the same untrusted form data as everything
    // else, so it is validated against the closed allowlist rather than stored
    // as typed. An unrecognised value is dropped, not rejected: the type is a
    // label, and losing the label is a better outcome than losing the upload.
    const documentType: DocumentType | undefined = isDocumentType(
      parsed.data.documentType
    )
      ? parsed.data.documentType
      : undefined

    const resumeId = newResumeId()

    try {
      await deps.getResumes().put({
        // The session's userId, never anything from the form. This is what
        // makes ownership structural: there is no way to *name* another user's
        // prefix, so the check inside the store is a second line rather than
        // the only one.
        userId: caller.userId,
        // A v4 uuid: 36 characters of [0-9a-f-], starting and ending
        // alphanumeric, which is what `assertSegment` requires. The uploaded
        // filename is never a key segment — it is metadata.
        resumeId,
        extension: check.extension,
        bytes,
        originalFilename: file.name,
        ...(documentType ? { documentType } : {}),
      })
    } catch (error) {
      return fail(storageMessage("upload", error))
    }

    // The nonce is the new object's id: unique per success by construction, so
    // the uploader can key its fields on it and reset without an effect.
    return {
      status: "success",
      message: `Uploaded ${file.name}.`,
      nonce: resumeId,
    }
  }

  async function deleteDocument(
    _state: DocumentActionState,
    formData: FormData
  ): Promise<DocumentActionState> {
    // No `carryNonce` here, unlike the upload. Nothing keys on a delete's
    // nonce — the button lives inside the row it deletes, so a success unmounts
    // it rather than resetting it — and inventing a use for the value would be
    // symmetry for its own sake.
    const caller = await requireUser()
    if (!caller.ok) return { status: "error", message: caller.message }

    const resumeId = resumeIdSchema.safeParse(formData.get("resumeId"))
    const extension = extensionSchema.safeParse(formData.get("extension"))

    if (!resumeId.success || !extension.success) {
      return { status: "error", message: "That document could not be found." }
    }

    try {
      await deps.getResumes().delete({
        // Again the session's userId. A tampered hidden field can name a
        // different *object*, but never a different owner's prefix — the key is
        // built from an id the form never supplies.
        userId: caller.userId,
        resumeId: resumeId.data,
        extension: extension.data,
      })
    } catch (error) {
      return { status: "error", message: storageMessage("delete", error) }
    }

    // Recoverable rather than destructive, which is why exposing this at all is
    // proportionate: the bucket is versioned, so a delete writes a marker and
    // the previous version survives until the 365-day noncurrent-expiry rule
    // removes it.
    return {
      status: "success",
      message: "Document deleted.",
      nonce: resumeId.data,
    }
  }

  return { uploadDocument, deleteDocument }
}

/**
 * An error state that preserves whatever nonce the previous state held.
 *
 * The uploader keys its fields on the nonce, so the nonce is not really an
 * identifier — it is "how many times has an upload succeeded". A failure is not
 * a success, so it must not move that number. Building the error state without
 * the previous nonce reads as harmless and is not: the key flips back to its
 * initial value, React remounts the fields, and the file the user picked is
 * discarded underneath the message telling them to try again.
 *
 * Takes the whole previous state rather than a nonce so that a caller cannot
 * pass the wrong one, and so the `idle` case — nothing to carry — is handled
 * here once.
 */
function carryNonce(
  previous: DocumentActionState,
  message: string
): DocumentActionState {
  const nonce = previous.status === "idle" ? undefined : previous.nonce

  return { status: "error", message, ...(nonce ? { nonce } : {}) }
}

/**
 * A storage failure as something safe to show.
 *
 * Branches on `code`, never `instanceof` — `errors.ts` says so explicitly, and
 * the reason is real: an error crossing a bundler or package boundary can fail
 * a prototype check while carrying a perfectly good discriminant.
 *
 * Detail goes to the server log and nowhere else, matching `chat-handler.ts`.
 */
function storageMessage(
  // Narrowed from `string` because a branch below turns on it, and a typo in a
  // call site would silently pick the delete wording for an upload.
  operation: "upload" | "delete",
  error: unknown
): string {
  console.error(`documents: ${operation} failed`, error)

  if (!isUserStorageError(error)) return "Something went wrong."

  switch (error.code) {
    case "invalid_object_key":
      // Two very different situations behind one code, so the copy follows the
      // operation rather than the error.
      //
      // On an upload it is reachable, and not only through a bad extension:
      // `cleanFilename` in the resume store throws when a filename has no
      // representable ASCII left at all, which `checkUpload` does not catch
      // because the extension is fine. "Check the file name" is the right
      // advice, and the user has a file in front of them to check.
      //
      // On a delete there is no file and no name to check — the id came from a
      // hidden field the user never saw. `resumeIdSchema` should have caught it
      // first, so reaching here means the row is unaddressable, which is the
      // same thing as gone as far as anyone can act on it.
      return operation === "upload"
        ? "That file couldn't be stored. Check the file name and type."
        : "That document no longer exists."

    case "object_not_found":
    case "object_ownership":
      // **The same message, deliberately.** `errors.ts` says a caller that must
      // not learn whether an object exists should conflate the two, and that
      // the choice should be visible where it is made rather than buried in the
      // error class. Splitting these would turn a delete form into an oracle
      // for whether another user's document id is real.
      return "That document no longer exists."

    case "storage_unavailable":
      // Where `AccessDenied` lands, which matters for diagnosis more than for
      // the user: a broken IAM attachment or a mismatched OIDC subject surfaces
      // here as a transient-sounding message, not as a 404. If this appears
      // consistently on a fresh deploy, read the function logs — the cause is
      // in the AssumeRoleWithWebIdentity call, not in this app.
      return "Document storage is unavailable. Try again in a moment."

    default:
      return "Something went wrong."
  }
}
