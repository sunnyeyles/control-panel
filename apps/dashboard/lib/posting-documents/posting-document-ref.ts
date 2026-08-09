/**
 * Addressing one **Posting Document**.
 *
 * ## What `lib/posting-documents/` is
 *
 * The **Cover Letter** and the **Tailored Resume** agree on everything except
 * what they say — see the **Posting Document** entry in `CONTEXT.md`. This
 * directory holds the part they agree on. Each feature keeps its own directory
 * for the part it does not: its prompt, its request schema, and every sentence a
 * user reads.
 *
 * ⚠️ **It is not an object kind.** Nothing here writes to a
 * `posting-documents/` prefix, because no such prefix exists — the bucket keeps
 * `cover-letters` and `tailored-resumes` separate on purpose.
 *
 * **Nothing under this directory imports Next**, which is the rule the whole of
 * `lib/` follows — see the Server Action section of `apps/dashboard/CLAUDE.md`.
 *
 * ## This file
 *
 * A Posting Document is addressed by `(User, Posting)` and by nothing else,
 * where the User comes from the session and the Posting arrives from outside —
 * a form field, a URL segment. This is the check that value passes before it can
 * become a key segment.
 *
 * There is no composite `{id}{extension}` here as there is for documents,
 * because neither kind has an extension to carry — both stores fix it at `.md`.
 * The address is the Posting id and nothing else, which is why a download
 * route's path segment is the bare id.
 */

/**
 * The shape `postingId()` produces: sixteen lowercase hex characters.
 *
 * Restated here rather than exported from `@workspace/agents`, because what is
 * being enforced is *the shape of a value arriving from outside* — a form
 * field, a URL segment — and not that function's contract. The two agree today
 * and this check must fail closed whatever the function does tomorrow.
 *
 * It is deliberately tighter than the key-segment rule in
 * `@workspace/user-storage`, for the same reason `document-ref.ts` pins the
 * uuid shape: every value that passes here is a legal key segment by
 * construction, so a malformed one is refused where the wording fits rather
 * than deep in the store.
 *
 * **One copy, for both kinds.** It began in `cover-letter-actions.ts`, moved
 * beside the letter's ref module when the download route needed the same rule,
 * and moved here when the tailored resume turned out to be addressed by exactly
 * the same value. Two copies of a pattern that gates key construction is how one
 * of them gets relaxed alone.
 *
 * **The shape is stated a second time, in SQL, and that one is deliberate.**
 * `packages/db/prisma/migrations/0005_postings/migration.sql` constrains
 * `postings.posting_id` with `postings_posting_id_check` — the same sixteen hex
 * characters, in a different language doing a different job. This pattern
 * validates *untrusted input* on its way to a key segment, and stays the only
 * copy of that; the CHECK refuses to *store* a value that could never be a key
 * segment at all, exactly as `artifacts_object_key_check` refuses a URL where a
 * key belongs. Neither can stand in for the other — a database cannot see a
 * form field, and a TypeScript guard cannot see a row a backfill wrote — so the
 * rule against a second copy of *this* check is unaffected by it.
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
 * itself derived. It sits beside the pattern rather than beside either gate
 * because both of them refuse the same field for the same reason —
 * `prepare-posting-document.ts` before a model is asked for a document, and
 * `edit-posting-document.ts` before a stored one is overwritten — and a second
 * copy is how one of them ends up saying something the other does not.
 *
 * One string for both kinds, because it names the **Posting** rather than the
 * document — the same reason `POSTING_NOT_FOUND` is shared.
 *
 * ⚠️ **Not the answer for a *download*.** `downloadPostingDocument` refuses the
 * same shape with `not-found` and no sentence at all, because there a malformed
 * id and an absent object must be indistinguishable; here the caller is holding
 * a form and being told it is unusable.
 */
export const BAD_REQUEST = "That posting could not be identified."
