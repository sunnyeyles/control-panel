/**
 * Addressing one stored cover letter, and naming the file a download produces.
 *
 * Imports nothing from Next, for the reason `lib/documents/document-ref.ts`
 * gives about itself: a test can reach it, and the shape a value must have
 * before it becomes a key segment is exactly the thing worth testing.
 *
 * There is no composite `{id}{extension}` here as there is for documents,
 * because a letter has no extension to carry — `cover-letter-store.ts` fixes it
 * at `.md`. The address is the Posting id and nothing else, which is why the
 * download route's path segment is the bare id.
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
 * **One copy, in this module.** It began in `cover-letter-actions.ts`, and the
 * download route needed the same rule the moment a letter could be fetched
 * back. Two copies of a pattern that gates key construction is how one of them
 * gets relaxed alone.
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

/** Whether a value from a form or a URL can address a letter at all. */
export function isPostingId(value: unknown): value is string {
  return typeof value === "string" && POSTING_ID_PATTERN.test(value)
}

/** What is known about the Posting a letter was drafted for, for naming it. */
export interface CoverLetterNameParts {
  postingId: string
  title?: string
  company?: string
}

/**
 * The filename a download is offered under.
 *
 * The Posting id is a hex digest, so a download named after it is a file nobody
 * can identify a week later in their downloads folder. Title and company come
 * from object metadata, which the store already stripped to printable ASCII on
 * the way in ({@link ../../../packages/user-storage/src/metadata.ts}) — but this
 * still restricts them further, because a filename is a filename: path
 * separators would suggest a directory to whatever unpacks it, and the download
 * route's own `contentDisposition()` escaping is the header's concern rather
 * than this one's.
 *
 * Falls back to the id when nothing usable survives, which is what a letter
 * written before provenance existed, or one whose `head()` failed, will hit.
 */
export function coverLetterFilename(parts: CoverLetterNameParts): string {
  const subject = [parts.title, parts.company]
    .map((part) => cleanNamePart(part))
    .filter((part) => part.length > 0)
    .join(" - ")

  return subject.length > 0
    ? `Cover letter - ${subject}.md`
    : `Cover letter - ${parts.postingId}.md`
}

/**
 * A metadata value as a filename can carry it.
 *
 * Path separators and the characters Windows refuses become spaces rather than
 * being deleted, so `A/B` reads as two words instead of silently becoming `AB`.
 * Runs of whitespace collapse for the same reason a title with a stray tab in
 * it should not produce a filename with a gap in the middle.
 */
function cleanNamePart(value: string | undefined): string {
  if (!value) return ""

  return value
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim()
}
