/**
 * Making a value safe to travel as S3 user metadata.
 *
 * ⚠️ **S3 user-metadata values are HTTP headers.** A value carrying a newline
 * is header injection, and a non-ASCII one is silently mangled somewhere
 * between the SDK and the bucket. Neither failure is visible at the call site:
 * the write succeeds and the stored object is wrong, or worse, the request is
 * not the request the caller thought it was making.
 *
 * This module exists because that cleaning was written once, for an uploaded
 * filename, inside `resume-store.ts` — and the second caller that needs it
 * (`cover-letter-store.ts`, whose provenance values are text a model copied out
 * of an advertisement) must not restate the rule. Model-copied company names
 * and titles are exactly the values most likely to carry an em dash, a
 * non-breaking space, or a stray newline, so this is a live path rather than a
 * formality.
 *
 * Nothing here validates a *key*. S3 lowercases metadata names in transit; the
 * names this package writes are its own compile-time constants, never caller
 * input, so there is nothing to sanitise on that side.
 */

/**
 * The longest a single value may be after cleaning.
 *
 * S3's real limit is on the total size of all user metadata (2 KB), not on any
 * one value, so this is a per-value budget chosen so that a handful of them
 * cannot add up to it. Truncating rather than refusing is right here and wrong
 * for a document body: metadata is provenance for a human reading it later, and
 * a clipped company name is still the company.
 */
export const MAX_METADATA_VALUE_CHARS = 255

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
 * `undefined` rather than an empty string, so a caller spreads the result into
 * a metadata record and an unrepresentable value simply is not written — a
 * present-but-empty metadata field says "we know this and it is blank", which
 * is a different and false claim.
 *
 * Callers that must have the value — an uploaded filename, which is the only
 * thing standing between a document and being unnamed — check for `undefined`
 * and raise. See `cleanFilename` in `resume-store.ts`.
 */
export function toMetadataValue(
  value: string | undefined | null,
  maxLength: number = MAX_METADATA_VALUE_CHARS
): string | undefined {
  if (typeof value !== "string") return undefined

  const safe = value.replace(UNSAFE, "").slice(0, maxLength).trim()

  return safe.length > 0 ? safe : undefined
}

/**
 * A whole record of provenance, cleaned, with unrepresentable entries dropped.
 *
 * The shape callers actually want: they hold several optional values at once
 * and want a `metadata` object with the survivors in it.
 */
export function toMetadataRecord(
  values: Record<string, string | undefined | null>,
  maxLength: number = MAX_METADATA_VALUE_CHARS
): Record<string, string> {
  const cleaned: Record<string, string> = {}

  for (const [key, value] of Object.entries(values)) {
    const safe = toMetadataValue(value, maxLength)
    if (safe !== undefined) cleaned[key] = safe
  }

  return cleaned
}
