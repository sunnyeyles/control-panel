import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import { isUserStorageError } from "@workspace/user-storage"
import { z } from "zod"

import { BAD_REQUEST, POSTING_ID_PATTERN } from "./posting-document-ref"

/**
 * Saving an edited **Posting Document** over the stored one, in one call.
 *
 * ## Why this exists
 *
 * Saving a Cover Letter and saving a Tailored Resume performed the same seven
 * steps in the same order, and the second was written by copying the first. Two
 * of the seven are security properties and one is a data-fidelity property, so
 * two copies meant two places to weaken them and a review that had to notice
 * the difference between them.
 *
 * ⚠️ **The order is the property, not an implementation detail.** Who is asking
 * is settled before the body is touched; the id is refused on *shape* before the
 * store is asked anything, so a malformed value cannot be probed with and cannot
 * fill the log with alarms anyone can trigger; and the object must be shown to
 * exist before anything is written. A caller that reordered these would still
 * compile and would still pass a happy-path test.
 *
 * ⚠️ **This is the action that accepts document text from a form, and {@link
 * PostingDocumentEdit} `"not-found"` is what keeps it from being a way to create
 * one.** Neither drafting nor generating takes text from a caller — they carry
 * one identifier and re-read the Posting server-side, which is what stops
 * arbitrary text landing in a document stored in the user's own name. Saving is
 * safe only for as long as it can do nothing but overwrite something the caller
 * already has. Manual creation is a *different* action with a different rule:
 * `createCoverLetter` re-reads the owned Posting before it accepts a first
 * letter, and there is deliberately no resume counterpart.
 *
 * ## What it deliberately does not do
 *
 * **It returns a reason, never a sentence** — except where the sentence already
 * has exactly one owner elsewhere (`requireUser`, `storageMessage`,
 * {@link BAD_REQUEST}), in which case it is carried as `"refused"` and the
 * caller passes it straight on. That is the same rule
 * `prepare-posting-document.ts` follows and the same rule the repo follows
 * generally: shared modules return a reason union, feature modules own the
 * sentences. The three reasons returned bare are the three a *feature* has to
 * word, and each names its own document — "the letter is empty" and "the resume
 * is empty" are the same condition told differently.
 *
 * **It does not own the length bound.** {@link EditPostingDocumentOptions.maxChars}
 * comes from the caller, because `MAX_LETTER_CHARS` and `MAX_RESUME_CHARS` are
 * the same number today by coincidence of scale rather than because one implies
 * the other, and the sentence naming the limit is the feature's.
 *
 * **Nothing here imports Next**, which is the rule the whole of `lib/` follows.
 */

/** The two fields either save form is allowed to carry. */
const requestSchema = z.object({
  postingId: z.string().regex(POSTING_ID_PATTERN),
  markdown: z.string(),
})

/**
 * The outcome of a save.
 *
 * `"refused"` is a sentence somebody else already owns. The other three are
 * conditions the feature words for its own document — see the module docblock.
 */
export type PostingDocumentEdit =
  | { ok: true }
  | { ok: false; reason: "refused"; message: string }
  /** Nothing survived the trim. */
  | { ok: false; reason: "empty" }
  /** Longer than {@link EditPostingDocumentOptions.maxChars}. */
  | { ok: false; reason: "too-long" }
  /**
   * There is no document at that address to edit.
   *
   * Also the "not yours" answer, conflated **deliberately**: the key is built
   * from the session's user, so another user's document is not merely refused —
   * it cannot be addressed at all, and what the caller reaches is an empty
   * prefix. The download path makes the identical conflation.
   */
  | { ok: false; reason: "not-found" }

/**
 * The two methods this needs, stated structurally.
 *
 * Both facades satisfy it without being named — the same arrangement
 * `DownloadablePostingDocuments` uses, and for the same reason:
 * `@workspace/user-storage` gains no shared supertype it has no other use for.
 *
 * ⚠️ **`T` is why this is generic rather than a fixed shape.** The facades name
 * the writing instant after what their kind does — `draftedAt` for a letter,
 * `generatedAt` for a resume — and they must keep differing forever, because
 * both names are stamped on objects that already exist and there is no
 * copy-onto-itself to rename them with. Threading the stored type through means
 * this module never has to know which name it is: it hands `head()`'s answer
 * straight back to `put()` with new markdown on it, and whatever the instant is
 * called travels across untouched. See `PostingDocumentStoreOptions.instantKey`.
 */
export interface EditablePostingDocuments<T> {
  /** Metadata only. Its answer is what gets carried across. */
  head(ref: { userId: string; postingId: string }): Promise<T>
  put(document: T & { markdown: string }): Promise<unknown>
}

export interface EditPostingDocumentOptions {
  /**
   * The object kind, for the server-side log line only.
   *
   * It reaches nothing the caller can be told apart by.
   */
  kind: string
  /**
   * The longest document that can be saved.
   *
   * The writing paths need no such bound because a model wrote the bytes and its
   * own output limit is the ceiling. Here a person does, through a rich-text
   * editor that will paste whatever is on a clipboard.
   */
  maxChars: number
}

export interface EditPostingDocumentDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
}

export async function editPostingDocument<T>(
  deps: EditPostingDocumentDeps,
  formData: FormData,
  documents: EditablePostingDocuments<T>,
  { kind, maxChars }: EditPostingDocumentOptions
): Promise<PostingDocumentEdit> {
  const refused = (message: string): PostingDocumentEdit => ({
    ok: false,
    reason: "refused",
    message,
  })

  // Before the body is touched at all. For a Server Action this is not a second
  // layer: `proxy.ts` cannot evaluate a POST session — the auth SDK's fast path
  // is guarded by `method === "GET"` — so it degrades to checking that some
  // session-cookie substring is present. This is the only real check on the path.
  const caller = await requireUser(deps.getUser, kind)
  if (!caller.ok) return refused(caller.message)

  const parsed = requestSchema.safeParse({
    postingId: formData.get("postingId"),
    markdown: formData.get("markdown"),
  })
  if (!parsed.success) return refused(BAD_REQUEST)

  // Normalized before it is measured and before it is stored. Two separate
  // reasons:
  //
  // ⚠️ **`\r\n` is for the POST, not for the editor — nothing the UI does can
  // produce it.** ProseMirror normalizes `\r\n` to `\n` as it parses the
  // clipboard, so a document pasted out of a Windows editor is already LF before
  // it is a document; Turndown then emits LF, which
  // `packages/ui/src/lib/markdown.test.ts` pins. Both halves of the only path a
  // user has are covered, and this line is unreachable through it.
  //
  // It stays because a Server Action is reachable by direct POST with a FormData
  // nobody typed — see `apps/dashboard/CLAUDE.md` — and the store is told
  // `text/markdown`. Cheaper to normalize than to reason about later. Do not read
  // it as evidence the editor emits CRLF; comments in the two actions this
  // replaced had each claimed a source for it that does not hold.
  //
  // ⚠️ **Line endings are the only normalization this side does, and the larger
  // half is not here.** Whether an *unedited* save is a no-op depends on the
  // markdown dialect the editor round-trips through, which is fixed in
  // `createMarkdownSerializer()` and asserted there. This cannot check it: by the
  // time the bytes arrive they are already serialized.
  //
  // `trim()` because a document that is only whitespace is an empty one however
  // much of it there is, and Turndown leaves a trailing newline on nearly
  // everything.
  const markdown = parsed.data.markdown.replace(/\r\n/g, "\n").trim()

  // Measured on the normalized text, so a caller cannot spend the bound on
  // carriage returns the store would never have been given.
  if (markdown.length === 0) return { ok: false, reason: "empty" }
  if (markdown.length > maxChars) return { ok: false, reason: "too-long" }

  // ⚠️ **The session's userId, never anything from the form.** There is no way
  // to *name* another user's prefix from here, which is what makes the
  // key-segment assertion in the store a second line of defence rather than the
  // only one.
  const ref = { userId: caller.userId, postingId: parsed.data.postingId }

  let existing: T
  try {
    existing = await documents.head(ref)
  } catch (error) {
    if (
      isUserStorageError(error) &&
      (error.code === "object_not_found" ||
        error.code === "object_ownership" ||
        error.code === "invalid_object_key")
    ) {
      return { ok: false, reason: "not-found" }
    }

    // Anything else is the bucket being unreachable, which must not be reported
    // as "you have not written this" — that would tell a user their document is
    // gone during an outage.
    return refused(storageMessage(`${kind}: read failed`, error))
  }

  try {
    // ⚠️ **The stored document is handed back whole, with new markdown on it.**
    // An edit is not a writing: the instant and the provenance a document was
    // written with are carried across rather than restamped. The Posting card
    // renders "Cover letter drafted <date>", the detail panel renders "Generated
    // <date>" and names the source Document, and the two lists render a title
    // and company out of provenance — so a save that restamped either would have
    // the page report that the model rewrote the document just now, or blank a
    // row down to a hex digest. Spreading `head()`'s answer rather than naming
    // the fields is what makes that true of fields added later as well.
    await documents.put({ ...existing, ...ref, markdown })
  } catch (error) {
    return refused(storageMessage(`${kind}: write failed`, error))
  }

  return { ok: true }
}
