/** What is known about the Posting a document belongs to, for naming it. */
export interface PostingDocumentNameParts {
  postingId: string
  title?: string
  company?: string
}

/**
 * The filename a download of a Posting-addressed document is offered under.
 *
 * The Posting id is a hex digest, so a download named after it is a file nobody
 * can identify a week later in their downloads folder. Title and company come
 * from object metadata, which the store already stripped to printable ASCII on
 * the way in (`packages/user-storage/src/metadata.ts`) — but this still
 * restricts them further, because a filename is a filename: path separators
 * would suggest a directory to whatever unpacks it, and a download route's own
 * `contentDisposition()` escaping is the header's concern rather than this one's.
 *
 * Falls back to the id when nothing usable survives, which is what a document
 * written before provenance existed, or one whose `head()` failed, will hit.
 *
 * **`label` is the only thing the two callers differ by**, which is why this is
 * one function rather than two. `cleanNamePart` below is the part worth not
 * copying: it is the second-narrowest rule a Posting's title passes through on
 * its way out of the system, and a second copy is how one of them gets relaxed
 * alone. Same argument as `POSTING_ID_PATTERN` having exactly one copy.
 */
export function postingDocumentFilename(
  label: string,
  parts: PostingDocumentNameParts
): string {
  const subject = [parts.title, parts.company]
    .map((part) => cleanNamePart(part))
    .filter((part) => part.length > 0)
    .join(" - ")

  return subject.length > 0
    ? `${label} - ${subject}.md`
    : `${label} - ${parts.postingId}.md`
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
