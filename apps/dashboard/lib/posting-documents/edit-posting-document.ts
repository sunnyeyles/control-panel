import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import { isUserStorageError } from "@workspace/user-storage"
import { z } from "zod"

import { BAD_REQUEST, POSTING_ID_PATTERN } from "./posting-document-ref"

/**
 * Saving an edited **Posting Document** over the stored one, in one call.
 *
 * Shared by the Cover Letter and Tailored Resume saves, which performed the same
 * seven steps — two of them security properties and one data fidelity, so two
 * copies meant two places to weaken them.
 *
 * ⚠️ **The order is the property, not an implementation detail.** Who is asking
 * is settled before the body is touched; the id is refused on *shape* before the
 * store is asked anything, so it cannot be probed with or used to fill the log
 * with alarms; and the object must be shown to exist before anything is written.
 * A caller that reordered these would still compile and pass a happy-path test.
 *
 * ⚠️ **This is the action that accepts document text from a form, and {@link
 * PostingDocumentEdit} `"not-found"` is what keeps it from being a way to create
 * one.** Saving is safe only while it can do nothing but overwrite something the
 * caller already has. Manual creation is a different action with a different
 * rule: `createCoverLetter` re-reads the owned Posting first.
 *
 * **It returns a reason, never a sentence** — except where the sentence already
 * has one owner (`requireUser`, `storageMessage`, {@link BAD_REQUEST}), carried
 * as `"refused"`. The three bare reasons are the ones a feature has to word for
 * its own document. It does not own the length bound either: `maxChars` comes
 * from the caller, since `MAX_LETTER_CHARS` and `MAX_RESUME_CHARS` are alike by
 * coincidence of scale.
 *
 * Nothing here imports Next, the rule the whole of `lib/` follows.
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
 * Both facades satisfy it without being named, so `@workspace/user-storage`
 * gains no shared supertype it has no other use for.
 *
 * ⚠️ **`T` is why this is generic.** The facades name the writing instant after
 * their kind — `draftedAt` vs `generatedAt` — and must keep differing, since
 * both are already stamped on existing objects. Threading the stored type
 * through means `head()`'s answer goes straight back to `put()` with new
 * markdown on it. See `PostingDocumentStoreOptions.instantKey`.
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

  // ⚠️ **`\r\n` is for the POST, not for the editor — nothing the UI can do
  // produces it.** ProseMirror normalizes CRLF as it parses the clipboard and
  // Turndown emits LF (pinned by `packages/ui/src/lib/markdown.test.ts`), so
  // this line is unreachable through the UI. It stays because a Server Action is
  // reachable by direct POST with a FormData nobody typed. Do not read it as
  // evidence the editor emits CRLF.
  //
  // Line endings are the only normalization this side does; whether an *unedited*
  // save is a no-op depends on the markdown dialect, fixed and asserted in
  // `createMarkdownSerializer()`. `trim()` because whitespace-only is empty, and
  // Turndown leaves a trailing newline on nearly everything.
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
