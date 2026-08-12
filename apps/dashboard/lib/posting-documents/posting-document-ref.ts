/**
 * Addressing one **Posting Document**.
 *
 * `lib/posting-documents/` holds what the Cover Letter and the Tailored Resume
 * agree on (see `CONTEXT.md`); each feature keeps its own prompt, request schema
 * and user-facing sentences. **Nothing under it imports Next.**
 *
 * ⚠️ **It is not an object kind.** No `posting-documents/` prefix exists — the
 * bucket keeps `cover-letters` and `tailored-resumes` separate on purpose.
 *
 * A Posting Document is addressed by `(User, Posting)` and nothing else: the
 * User from the session, the Posting from outside. This is the check that value
 * passes before it can become a key segment. No composite `{id}{extension}` as
 * documents have — both stores fix the extension at `.md` — which is why a
 * download route's path segment is the bare id.
 */

/**
 * The shape `postingId()` produces: sixteen lowercase hex characters.
 *
 * Restated rather than imported from `@workspace/agents` because what is enforced
 * is the shape of a value *arriving from outside*, not that function's contract —
 * this must fail closed whatever the function does tomorrow. Deliberately tighter
 * than the key-segment rule in `@workspace/user-storage`, so a malformed value is
 * refused where the wording fits rather than deep in the store.
 *
 * ⚠️ **One copy, for both kinds.** Two copies of a pattern that gates key
 * construction is how one of them gets relaxed alone.
 *
 * The same shape in SQL (`postings_posting_id_check`) is not a second copy: this
 * validates untrusted input on its way to a key segment, the CHECK refuses to
 * *store* a value that could never be one. A database cannot see a form field,
 * and a guard cannot see a row a backfill wrote.
 */
export const POSTING_ID_PATTERN = /^[0-9a-f]{16}$/

/**
 * Whether a value from a form or a URL can address a Posting Document at all.
 */
export function isPostingId(value: unknown): value is string {
  return typeof value === "string" && POSTING_ID_PATTERN.test(value)
}

/**
 * What a value that failed {@link POSTING_ID_PATTERN} is answered with.
 *
 * Reachable only by posting a form directly; every button sends an id the app
 * derived. Sits beside the pattern because both gates refuse the same field for
 * the same reason, and one string serves both kinds because it names the
 * **Posting** rather than the document.
 *
 * ⚠️ **Not the answer for a *download*.** `downloadPostingDocument` refuses the
 * same shape with `not-found` and no sentence, because there a malformed id and
 * an absent object must be indistinguishable; here the caller holds a form and
 * is being told it is unusable.
 */
export const BAD_REQUEST = "That posting could not be identified."
