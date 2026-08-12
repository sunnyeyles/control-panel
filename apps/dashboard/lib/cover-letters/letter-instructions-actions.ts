import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import { parseDocumentFile } from "@/lib/documents/document-ref"
import {
  listDocuments,
  type DocumentSummary,
} from "@/lib/documents/list-documents"
import {
  MAX_EXAMPLE_LETTER_CHARS,
  MAX_INSTRUCTIONS_CHARS,
} from "@workspace/agents/cover-letter"
import {
  coverLetterInstructions,
  saveCoverLetterInstructions,
  type PrismaClient,
} from "@workspace/db"
import { type ResumeStore } from "@workspace/user-storage"
import { z } from "zod"

import {
  extractProfileText,
  isReadableProfileExtension,
  ProfileTextError,
  type ReadableProfileExtension,
} from "@/lib/candidate/profile-text"

/**
 * Saving the rules a user wants their cover letters written by, and filling the
 * example letter from a document they already uploaded.
 *
 * **Nothing in this file imports Next**, which is what lets the authorization
 * branches be tested at all — every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/letters/actions.ts`, which is `"use server"`, supplies the
 * real dependencies, and calls `refresh()`.
 *
 * Two properties hold across both actions, neither visible from the happy path:
 *
 * 1. **The row is addressed by the session's user id and by nothing else.** No
 *    form field reaches the `where` clause. `importExampleLetter` takes a
 *    document id, checked against the caller's own listing before it is read.
 * 2. **Over-length text is refused, never trimmed.** A silent trim would save a
 *    rule list ending mid-sentence, or an example missing its sign-off, and say
 *    nothing — and the letters drafted afterwards would look perfectly fine.
 *
 * Both fields save in one call, because a save is the whole setting rather than a
 * patch of it — which is why both are validated before either is written.
 */

/**
 * One message for "no such document" and "someone else's document".
 *
 * Distinct messages would turn a picker that takes a uuid into an oracle for
 * whether another user's document exists — the same reasoning
 * `POSTING_NOT_FOUND` in `cover-letter-actions.ts` and `NOT_FOUND` in
 * `lib/jobs/job-actions.ts` give for theirs.
 */
export const DOCUMENT_NOT_FOUND = "That document could not be found."

/**
 * Reachable only by posting the form directly — the section always submits both
 * textareas, and an empty one posts `""` rather than nothing — so the copy
 * points at the page rather than trying to name a field the user never saw.
 */
const MALFORMED_SAVE =
  "Those instructions could not be saved. Reload the page and try again."

/** The two fields, as they arrive from the form. */
type LetterField = "instructions" | "exampleLetter"

/**
 * Both fields, bounded by the agent package's own caps.
 *
 * `.trim()` before `.max()`, so trailing newlines from a paste are not what
 * pushes a letter over its limit — and so the number in the refusal is the
 * number of characters that would have been stored.
 *
 * ⚠️ **The caps are imported, not restated.** They bound the text that reaches
 * the composed system prompt, and a second copy here would be a second copy of
 * a number that has to move in lockstep with the prompt it bounds.
 */
const saveSchema = z.object({
  instructions: z.string().trim().max(MAX_INSTRUCTIONS_CHARS),
  exampleLetter: z.string().trim().max(MAX_EXAMPLE_LETTER_CHARS),
})

/** The document to import from, as `{resumeId}{extension}`. */
const importSchema = z.object({ file: z.string() })

export interface LetterInstructionsActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The client, resolved per call rather than held.
   *
   * Called inside the action bodies, never in the factory, so
   * `createLetterInstructionsActions(...)` at module scope in the wrapper
   * constructs nothing and cannot throw at import time on a missing
   * `DATABASE_URL`. Same for the store below.
   */
  getPrisma: () => PrismaClient
  /** Where the document being imported from is read. */
  getResumes: () => ResumeStore
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

export function createLetterInstructionsActions(
  deps: LetterInstructionsActionsDeps
) {
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  const requireCaller = () => requireUser(deps.getUser, "cover-letters")

  async function saveLetterInstructions(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // ⚠️ Before the body is touched, and the only real check on the path:
    // `proxy.ts` cannot evaluate a POST session, so it degrades to a cookie
    // presence check.
    const caller = await requireCaller()
    if (!caller.ok) return fail(caller.message)

    const raw = {
      instructions: formData.get("instructions"),
      exampleLetter: formData.get("exampleLetter"),
    }

    // Both fields, or neither. `saveCoverLetterInstructions` writes the whole
    // setting, so validating one and then discovering the other is over its cap
    // would mean a save that half happened with a message saying it did not.
    const parsed = saveSchema.safeParse(raw)

    if (!parsed.success) return fail(describeSaveFailure(raw, parsed.error))

    try {
      await saveCoverLetterInstructions(deps.getPrisma(), caller.userId, {
        // ⚠️ The session's userId, never a form field. Instructions are keyed
        // on who is asking, which is also why the draft action reads them from
        // the database rather than accepting them in its own form.
        ...parsed.data,
      })
    } catch (error) {
      console.error("cover-letters: could not save the instructions", error)
      return fail("Something went wrong.")
    }

    return {
      status: "success",
      message: "Cover letter instructions saved.",
      resetKey: newResetKey(),
    }
  }

  async function importExampleLetter(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched at all, for the reason above.
    const caller = await requireCaller()
    if (!caller.ok) return fail(caller.message)

    const parsed = importSchema.safeParse({ file: formData.get("file") })

    if (!parsed.success) return fail("Choose a document to fill it from.")

    // The download route's path segment, parsed by the one function that owns
    // that shape rather than by a second regex written here. An id that is not
    // a legal key segment never reaches the store at all.
    const ref = parseDocumentFile(parsed.data.file)

    if (!ref) return fail(DOCUMENT_NOT_FOUND)

    const resumes = deps.getResumes()

    let documents: DocumentSummary[]
    try {
      // ⚠️ **The ownership check, and it is structural.** `listDocuments` takes
      // the session's userId, so someone else's document id is simply absent —
      // which is why the refusal below cannot tell the two apart in principle.
      documents = await listDocuments(caller.userId, deps.getPrisma())
    } catch (error) {
      return fail(storageMessage("cover-letters: list failed", error))
    }

    const document = documents.find(
      (candidate) =>
        candidate.documentId === ref.documentId &&
        candidate.extension === ref.extension
    )

    if (!document) return fail(DOCUMENT_NOT_FOUND)

    if (!isReadableProfileExtension(document.extension)) {
      // Named rather than lumped in: `resumes` accepts more on upload than
      // anything can read, so the user is being refused a document this app
      // already took — without the extension in the sentence that reads as a bug.
      return fail(describeUnreadableFormat(document))
    }

    // Narrowed above; restated here so the extension reaches
    // `extractProfileText` as a `ReadableProfileExtension` rather than a
    // `string`, which is what makes the exhaustive switch there load-bearing.
    const extension: ReadableProfileExtension = document.extension

    let bytes: Uint8Array
    try {
      const fetched = await resumes.get({
        // The session's userId again. A tampered field can name a different
        // object; it can never name a different owner's prefix.
        userId: caller.userId,
        resumeId: ref.documentId,
        extension,
      })

      bytes = fetched.bytes ?? new Uint8Array()
    } catch (error) {
      return fail(storageMessage("cover-letters: read failed", error))
    }

    let extracted: string
    try {
      extracted = (await extractProfileText(extension, bytes)).trim()
    } catch (error) {
      if (error instanceof ProfileTextError) {
        // A message, never a throw out of the action. The parser's own words
        // are about internal file structure and go to the log alone — see
        // `ProfileTextError`.
        console.error(
          "cover-letters: could not extract an example letter from",
          document.file,
          error.cause ?? error
        )
        return fail(describeUnreadableDocument(document))
      }

      throw error
    }

    // A scanned PDF parses perfectly and yields nothing. Refused here rather
    // than stored, because an example letter that is the empty string is
    // indistinguishable from never having imported one — and the import would
    // report success having quietly cleared the field.
    if (extracted.length === 0) return fail(describeEmptyDocument(document))

    if (extracted.length > MAX_EXAMPLE_LETTER_CHARS) {
      return fail(describeTooLongDocument(document, extracted.length))
    }

    try {
      // ⚠️ **Read before write, and in the same `try`.** A save writes both
      // fields, so importing an example has to carry the instructions the user
      // already wrote through unchanged. If this read throws, nothing is
      // written at all — writing an empty `instructions` here would delete
      // their rules as a side effect of filling a different box.
      const prisma = deps.getPrisma()
      const existing = await coverLetterInstructions(prisma, caller.userId)

      await saveCoverLetterInstructions(prisma, caller.userId, {
        instructions: existing?.instructions ?? "",
        exampleLetter: extracted,
      })
    } catch (error) {
      console.error("cover-letters: could not save the imported example", error)
      return fail("Something went wrong.")
    }

    return {
      status: "success",
      // Names the document, because the picker sits below a box the import
      // replaces and "done" would not say which of several letters landed in it.
      message: `Filled the example letter from ${document.displayName}.`,
      resetKey: newResetKey(),
    }
  }

  return { saveLetterInstructions, importExampleLetter }
}

/**
 * Why a save was refused, in the words that name the numbers.
 *
 * The count is recomputed from the raw field rather than read off the issue,
 * because zod reports the *limit* it checked and not the length it saw. Trimmed
 * first, matching {@link saveSchema}, so the number quoted is the number of
 * characters that would have been stored.
 */
function describeSaveFailure(
  raw: Record<LetterField, FormDataEntryValue | null>,
  error: z.ZodError
): string {
  for (const issue of error.issues) {
    const field = issue.path[0]

    if (issue.code !== "too_big") continue
    if (field !== "instructions" && field !== "exampleLetter") continue

    const value = raw[field]
    const length = typeof value === "string" ? value.trim().length : 0

    return describeTooLong(field, length)
  }

  return MALFORMED_SAVE
}

function describeTooLong(field: LetterField, length: number): string {
  if (field === "instructions") {
    return `Your instructions are ${length} characters, over the ${MAX_INSTRUCTIONS_CHARS} limit. Nothing was saved and nothing was trimmed — shorten them by ${length - MAX_INSTRUCTIONS_CHARS} characters and save again.`
  }

  return `Your example letter is ${length} characters, over the ${MAX_EXAMPLE_LETTER_CHARS} limit. Nothing was saved and nothing was trimmed — shorten it by ${length - MAX_EXAMPLE_LETTER_CHARS} characters and save again.`
}

/**
 * The three ways an import can fail on the document itself.
 *
 * Each names the document, because the picker offers several and a refusal that
 * does not say which one it is about is a refusal the user cannot act on. Each
 * also says what to do instead — pasting into the box above is always available,
 * and is the one route that cannot fail.
 */
function describeUnreadableFormat(document: DocumentSummary): string {
  return `${document.displayName} is a ${document.extension} file, and reading those is not built yet. Save the same letter as a PDF, a Word .docx, or a .md or .txt file and upload that — or paste the letter into the box above.`
}

function describeUnreadableDocument(document: DocumentSummary): string {
  return `${document.displayName} could not be read. The file may be damaged, or not really the format its name says. Try re-exporting it, or paste the letter into the box above.`
}

function describeEmptyDocument(document: DocumentSummary): string {
  return `No text could be read out of ${document.displayName}. If it is a scan or a photo of a printed letter there is no text in it to extract — paste the letter into the box above instead.`
}

function describeTooLongDocument(
  document: DocumentSummary,
  length: number
): string {
  return `${document.displayName} is ${length} characters, over the ${MAX_EXAMPLE_LETTER_CHARS} limit for an example letter. It is refused rather than trimmed — a letter half-copied is still a style reference, and nothing would say which half. Paste the part you want imitated into the box above.`
}
