import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { DOCUMENT_GONE, storageMessage } from "@/lib/actions/storage-message"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  acceptedResumeExtensions,
  isDocumentType,
  type DocumentType,
  type ResumeStore,
} from "@workspace/user-storage"
import { z } from "zod"

import { EXTENSION_PATTERN, RESUME_ID_PATTERN } from "./document-ref"
import {
  checkUpload,
  describeRejection,
  MAX_REQUEST_BYTES,
} from "./upload-validation"

/**
 * The document actions, as plain functions over injected dependencies.
 *
 * **Nothing in this file imports Next.** That is what lets the security
 * branches be tested at all: every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/documents/actions.ts`, which is `"use server"`, supplies the real
 * dependencies, and calls `refresh()` — cache invalidation needs a request
 * store, so it stays there rather than here.
 *
 * The shape mirrors `lib/chat-handler.ts`: a `createXActions(deps)` factory with
 * an injectable `getUser` seam, the auth check before any body handling, and
 * client-facing messages that say less than the server log does.
 */

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
 * The patterns come from `document-ref.ts`, which is also what the download
 * route parses its path segment with. Why they are as tight as they are is
 * documented there; what matters here is that a malformed field is rejected on
 * this path, where the wording fits, rather than deep in the store, where the
 * only message available is about storing a file.
 */
const resumeIdSchema = z.string().regex(RESUME_ID_PATTERN)
const extensionSchema = z.string().regex(EXTENSION_PATTERN)

export function createDocumentActions(deps: DocumentActionsDeps) {
  const newResumeId = deps.newResumeId ?? (() => crypto.randomUUID())

  const requireCaller = () => requireUser(deps.getUser, "documents")

  async function uploadDocument(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    // Every failure below goes through this rather than building its own error
    // state, so the carried reset key cannot be forgotten on one branch out of
    // eight — which is exactly how the form came to reset itself mid-retry.
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched at all.
    //
    // Not belt-and-braces here, unlike on a GET. `proxy.ts` cannot evaluate a
    // non-GET request — `@neondatabase/auth`'s session fast path is guarded by
    // `method === "GET"` — so for this POST it degrades to checking that *some*
    // session cookie substring is present. This is the only real check on the
    // path, and Next's own documentation says the same thing: a Server Function
    // is reachable by direct POST, not only through the UI.
    const caller = await requireCaller()
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
      return fail(
        storageMessage("documents: upload failed", error, {
          invalidObjectKey:
            "That file couldn't be stored. Check the file name and type.",
        })
      )
    }

    // The reset key is the new object's id: unique per success by construction, so
    // the uploader can key its fields on it and reset without an effect.
    return {
      status: "success",
      message: `Uploaded ${file.name}.`,
      resetKey: resumeId,
    }
  }

  async function deleteDocument(
    _state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    // No `carryResetKey` here, unlike the upload. Nothing keys on a delete's
    // reset key — the button lives inside the row it deletes, so a success unmounts
    // it rather than resetting it — and inventing a use for the value would be
    // symmetry for its own sake.
    const caller = await requireCaller()
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
      return {
        status: "error",
        message: storageMessage("documents: delete failed", error, {
          invalidObjectKey: DOCUMENT_GONE,
        }),
      }
    }

    // Recoverable rather than destructive, which is why exposing this at all is
    // proportionate: the bucket is versioned, so a delete writes a marker and
    // the previous version survives until the 365-day noncurrent-expiry rule
    // removes it.
    return {
      status: "success",
      message: "Document deleted.",
      resetKey: resumeId.data,
    }
  }

  return { uploadDocument, deleteDocument }
}
