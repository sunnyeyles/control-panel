/**
 * Trace summaries are read by people, and `1 posting(s)` is not English.
 *
 * `-es` after a sibilant, because "2 searchs" is not English either and the one
 * noun this is called with that needs it — `search` — is in the sentence a failed
 * run puts in front of somebody.
 */
export function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`

  return `${count} ${noun}${/(?:s|x|ch|sh)$/.test(noun) ? "es" : "s"}`
}
