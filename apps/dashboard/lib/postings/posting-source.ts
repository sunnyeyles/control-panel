import { boardForHost } from "@workspace/agents/job-boards"

/**
 * Which job board a Posting came from, derived from the URL it carries.
 *
 * **Derived rather than stored, and that is the decision worth not undoing.** A
 * source column would be a second copy of a fact `postings.url` already carries,
 * and one that can drift — a Run rewrites `url` on every sighting. Deriving also
 * gives every row written before this existed a label, with nothing to backfill.
 *
 * The scout is not asked for it either: a `source` field on the reported posting
 * makes provenance a claim the model makes, which is what the worker's id
 * resolution exists to refuse. A hostname is evidence; a model's assertion about
 * one is not.
 *
 * ⚠️ **This is presentation, and it lives here rather than in
 * `packages/agents/src/job-boards.ts` on purpose.** Stripping a `www.` and
 * picking a badge variant are this app's concerns; `boardForHost` stays the
 * single source of host-to-board truth and is not restated below — including the
 * dot-anchored suffix match that resolves `au.linkedin.com` and refuses
 * `notlinkedin.com`, tested in its own package.
 */

/** Where one Posting was found. */
export interface PostingSource {
  /**
   * How the badge reads: `"SEEK"`, `"Indeed"` or `"LinkedIn"` when the host is
   * one `JOB_BOARDS` names, and the bare hostname when it is not.
   */
  label: string
  /**
   * False when no board claimed the host, which picks the muted badge variant.
   * Worth surfacing: an unrecognised host is the signal that a board is missing
   * from `JOB_BOARDS`, and the hostname says which one to add.
   */
  recognised: boolean
}

/**
 * The board serving a Posting's URL, or `undefined` when the URL will not parse.
 *
 * ⚠️ **The parse failure is a real branch, not defensive padding.**
 * `postings.url` is `TEXT NOT NULL` with no CHECK — unlike `posting_id`, which
 * has one — so the database will hold whatever was written. `FindingsSchema`'s
 * `z.url()` makes a malformed value unlikely rather than impossible, and a row
 * that reaches the table must not lose its place over a badge. The guard is the
 * same one `normalisePostingUrl` uses on the same column's value.
 */
export function postingSource(url: string): PostingSource | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }

  const board = boardForHost(parsed.hostname)

  if (board !== undefined) {
    return { label: board.name, recognised: true }
  }

  // `www.` is noise on a label nobody is asked to click; the URL itself is in the
  // expanded detail, verbatim. ⚠️ Only the leading label goes — guessing where
  // the public suffix ends would turn `jobs.example.co.uk` into a wrong answer
  // rather than a long one.
  const host = parsed.hostname.toLowerCase()

  return {
    label: host.startsWith("www.") ? host.slice("www.".length) : host,
    recognised: false,
  }
}
