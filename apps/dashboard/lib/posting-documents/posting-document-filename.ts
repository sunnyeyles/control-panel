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
 * can identify a week later. Title and company come from object metadata, already
 * stripped to printable ASCII on the way in, but are restricted further here
 * because a filename is a filename — path separators would suggest a directory to
 * whatever unpacks it. Falls back to the id when nothing usable survives.
 *
 * **`label` is the only thing the two callers differ by**, which is why this is
 * one function rather than two; `cleanNamePart` is the part worth not copying.
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
