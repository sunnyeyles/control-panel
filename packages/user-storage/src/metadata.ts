/**
 * Making a value safe to travel as S3 user metadata.
 *
 * ⚠️ **S3 user-metadata values are HTTP headers.** A newline in a value is
 * header injection; a non-ASCII character is silently mangled between the SDK
 * and the bucket. Neither is visible at the call site — the write succeeds and
 * the stored object is wrong.
 *
 * Every caller uses this rather than restating the rule, which is how the
 * cleaning came to be filename-only inside `resume-store.ts`. An uploaded
 * filename and a form-supplied document type are the values most likely to
 * carry an em dash, a non-breaking space, or a stray newline.
 *
 * Nothing here validates a *key* — metadata names are this package's own
 * compile-time constants, never caller input.
 */

/**
 * The longest a single value may be after cleaning.
 *
 * S3's real limit is on the total size of all user metadata (2 KB), not on any
 * one value, so this is a per-value budget chosen so that a handful of them
 * cannot add up to it. Truncating rather than refusing is right here and wrong
 * for a document body: metadata is provenance for a human reading it later, and
 * a clipped filename still names the file.
 */
const MAX_METADATA_VALUE_CHARS = 255

/**
 * Printable US-ASCII, and nothing else.
 *
 * Deliberately a strip rather than an encode. RFC 2047 or percent-encoding
 * would preserve more, but both hand back a value that is only correct if every
 * future reader decodes it the same way — and the readers here are a console,
 * a log line, and a person. What survives is legible as itself.
 */
const UNSAFE = /[^\x20-\x7E]/g

/**
 * The value as a header can carry it, or `undefined` if nothing survives.
 *
 * `undefined` rather than an empty string, so spreading the result simply does
 * not write an unrepresentable value — a present-but-empty field would claim
 * "we know this and it is blank", which is false.
 *
 * Callers that must have the value check for `undefined` and raise; see
 * `cleanFilename` in `resume-store.ts`.
 */
export function toMetadataValue(
  value: string | undefined | null,
  maxLength: number = MAX_METADATA_VALUE_CHARS
): string | undefined {
  if (typeof value !== "string") return undefined

  const safe = value.replace(UNSAFE, "").slice(0, maxLength).trim()

  return safe.length > 0 ? safe : undefined
}
