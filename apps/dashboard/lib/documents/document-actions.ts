import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { DOCUMENT_GONE, storageMessage } from "@/lib/actions/storage-message"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  deleteDocument as deleteDocumentRow,
  DOCUMENT_TYPES,
  findDocument,
  recordDocument,
  type PrismaClient,
} from "@workspace/db"
import {
  acceptedResumeExtensions,
  type ResumeStore,
} from "@workspace/user-storage"
import { z } from "zod"

import { DOCUMENT_ID_PATTERN } from "./document-ref"
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
   * The database client, resolved per call for the same reason the store is.
   *
   * A Document is two things written in order — bytes in the bucket, then a row
   * naming them — so both dependencies are needed on the same path, and this
   * one is what the read paths now go through exclusively.
   */
  getPrisma: () => PrismaClient
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
  newDocumentId?: () => string
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
 * A stored document's id, as a hidden form field carries it.
 *
 * Untrusted, but never trusted to name a *user* — see `deleteDocument`. The
 * pattern comes from `document-ref.ts`, which is also what the download route
 * parses its path segment with. Why it is as tight as it is is documented
 * there; what matters here is that a malformed field is rejected on this path,
 * where the wording fits, rather than deep in the store.
 *
 * The extension used to be a second field beside it and is not any more: the
 * row carries it, so there is one less thing arriving from the browser.
 */
const documentIdSchema = z.string().regex(DOCUMENT_ID_PATTERN)

/**
 * The label the `<select>` posted, or `other`.
 *
 * `.catch` rather than a rejection, keeping the rule this path has always had:
 * the type is a label, and losing the label is a better outcome than losing the
 * upload. What changed is where an unrecognised value lands — the column is
 * `NOT NULL`, so it lands on `other`, which is the value that exists for
 * exactly this and reads as an honest answer rather than a missing one.
 *
 * The runtime import of `DOCUMENT_TYPES` is right *here*, on the server, and
 * would be wrong in `document-type-labels.ts` — see the note there.
 */
const docTypeSchema = z.enum(DOCUMENT_TYPES).catch("other")

export function createDocumentActions(deps: DocumentActionsDeps) {
  const newDocumentId = deps.newDocumentId ?? (() => crypto.randomUUID())

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
    // else, so it is narrowed here before it can reach the CHECK on the column.
    const documentType = docTypeSchema.parse(parsed.data.documentType)

    const documentId = newDocumentId()

    try {
      await deps.getResumes().put({
        // The session's userId, never anything from the form. This is what
        // makes ownership structural: there is no way to *name* another user's
        // prefix, so the check inside the store is a second line rather than
        // the only one.
        userId: caller.userId,
        // A v4 uuid: 36 characters of [0-9a-f-], starting and ending
        // alphanumeric, which is what `assertSegment` requires. Minted here
        // rather than by the database, because it is the object's key segment
        // and the object is written first. The uploaded filename is never a key
        // segment.
        //
        // `resumeId` is `ResumeStore`'s field name, not our word for it: that
        // storage kind is the shelf every upload goes on, not CVs. Ours is
        // `documentId`, and these three call sites are the only places the
        // misnomer is allowed — see `NAMING.md` § Known exceptions.
        resumeId: documentId,
        extension: check.extension,
        bytes,
        originalFilename: file.name,
        documentType,
      })
    } catch (error) {
      return fail(
        storageMessage("documents: upload failed", error, {
          invalidObjectKey:
            "That file couldn't be stored. Check the file name and type.",
        })
      )
    }

    // ⚠️ **Bytes first, then the row, and this order is not interchangeable.**
    // A failed upload after a successful insert leaves a document the user can
    // see and cannot open; a failed insert after a successful upload leaves an
    // object nothing points at — invisible, a few kilobytes, and collectable,
    // which is what the cleanup below tries to do immediately.
    try {
      await recordDocument(deps.getPrisma(), {
        id: documentId,
        userId: caller.userId,
        extension: check.extension,
        // The filename as the user typed it. Postgres holds it, so unlike the
        // provenance copy on the object it is not stripped to printable ASCII.
        filename: file.name,
        docType: documentType,
        byteSize: bytes.byteLength,
      })
    } catch (error) {
      console.error("documents: upload recorded no row", documentId, error)

      // Best effort, and deliberately not reported: the user's upload has
      // already failed, and a second message about a cleanup they did not ask
      // for explains nothing. The object is unreachable either way — no row
      // means no listing, no download and no delete button.
      await deps
        .getResumes()
        .delete({
          userId: caller.userId,
          resumeId: documentId,
          extension: check.extension,
        })
        .catch((cleanup: unknown) => {
          console.error(
            "documents: orphaned object left behind",
            documentId,
            cleanup
          )
        })

      return fail("That file couldn't be stored. Try again.")
    }

    // The reset key is the new object's id: unique per success by construction, so
    // the uploader can key its fields on it and reset without an effect.
    return {
      status: "success",
      message: `Uploaded ${file.name}.`,
      resetKey: documentId,
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

    const documentId = documentIdSchema.safeParse(formData.get("documentId"))

    if (!documentId.success) {
      return { status: "error", message: "That document could not be found." }
    }

    const prisma = deps.getPrisma()

    // The row is what says this document exists and whose it is. `findDocument`
    // filters on `userId` as well as `id`, so someone else's id is simply not
    // found — the caller gets one answer for "no such document" and "not
    // yours", which is what stops this being an existence oracle.
    let document: Awaited<ReturnType<typeof findDocument>>

    try {
      document = await findDocument(prisma, caller.userId, documentId.data)
    } catch (error) {
      console.error("documents: could not load the document to delete", error)
      return { status: "error", message: "Something went wrong." }
    }

    if (!document) {
      return { status: "error", message: DOCUMENT_GONE }
    }

    // ⚠️ **Row first, then the object, the mirror of the upload's order.** A
    // row removed with the object still there is an orphan in the bucket:
    // invisible and collectable. An object removed with the row still there is
    // a document the user can see and cannot open — so if the S3 call below
    // fails, the delete has still done what the user asked.
    let rowDeleted: boolean

    try {
      rowDeleted = await deleteDocumentRow(
        prisma,
        caller.userId,
        documentId.data
      )
    } catch (error) {
      console.error("documents: could not delete the row", error)
      return { status: "error", message: "Something went wrong." }
    }

    if (!rowDeleted) {
      return { status: "error", message: DOCUMENT_GONE }
    }

    try {
      await deps.getResumes().delete({
        // Again the session's userId. A tampered hidden field can name a
        // different *object*, but never a different owner's prefix — the key is
        // built from an id the form never supplies.
        userId: caller.userId,
        // `ResumeStore`'s field name, not ours.
        resumeId: document.id,
        // From the row, not from the form. One less untrusted field, and one
        // less way for the key to name something the row does not.
        extension: document.extension,
      })
    } catch (error) {
      // Logged, not reported. The row is gone, so the document is gone as far
      // as this application is concerned, and telling the user their delete
      // failed would be false.
      console.error(
        "documents: row deleted, object left behind",
        document.id,
        error
      )
    }

    // Recoverable rather than destructive, which is why exposing this at all is
    // proportionate: the bucket is versioned, so a delete writes a marker and
    // the previous version survives until the 365-day noncurrent-expiry rule
    // removes it.
    return {
      status: "success",
      message: "Document deleted.",
      resetKey: documentId.data,
    }
  }

  return { uploadDocument, deleteDocument }
}
