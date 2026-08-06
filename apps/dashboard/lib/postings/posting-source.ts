import { boardForHost } from "@workspace/agents/job-boards"

/**
 * Which job board a Posting came from, derived from the URL it carries.
 *
 * **Derived rather than stored, and that is the decision worth not undoing.**
 * `postings` has no source column and does not want one: `postingId()` already
 * derives a Posting's whole identity from its normalised URL, and
 * `boardForHost()` in `@workspace/agents` is already the one rule that turns a
 * host into a board. A column would be a second copy of a fact `postings.url`
 * carries — the shape `packages/db/README.md` argues against wherever it comes
 * up — and it would be a copy that can drift, because a Run rewrites `url` on
 * every sighting. Deriving also means every row written before this existed
 * carries a label, with no migration and nothing to backfill.
 *
 * The scout is not asked for it either. A `source` field on `PostingSchema`
 * would be the cheapest diff and the wrong one: it makes provenance a claim the
 * model makes, which is the class of thing the worker's verbatim-URL check
 * exists to refuse. A hostname is evidence; a model's assertion about a hostname
 * is not.
 *
 * ⚠️ **This is presentation, and it lives here rather than in
 * `packages/agents/src/job-boards.ts` on purpose.** That module's own doc says
 * it is "not a registry of tools" and that a board appears in it "when its URLs
 * need normalising". Stripping a `www.` and deciding which badge variant an
 * unrecognised host gets are this app's concerns. The registry stays the single
 * source of host-to-board truth and is not restated below — in particular the
 * dot-anchored suffix match that resolves `au.linkedin.com` and refuses
 * `notlinkedin.com` is `boardForHost`'s rule, tested in its own package.
 */

/** Where one Posting was found. */
export interface PostingSource {
  /**
   * How the badge reads: `"SEEK"`, `"Indeed"` or `"LinkedIn"` when the host is
   * one `JOB_BOARDS` names, and the bare hostname when it is not.
   */
  label: string
  /**
   * False when no board claimed the host, which is what picks the muted badge
   * variant. Worth surfacing rather than hiding: an unrecognised host on this
   * page is the signal that a board is missing from `JOB_BOARDS`, and the
   * hostname beside it says which one to add.
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

  // `www.` is noise on a label nobody is asked to click — the URL itself is in
  // the expanded detail, verbatim and unedited, for anyone who wants it. Only
  // the leading label goes: a host is stripped to what somebody would say out
  // loud, not to a registrable domain, because guessing where the public suffix
  // ends would turn `jobs.example.co.uk` into a wrong answer rather than a long
  // one.
  const host = parsed.hostname.toLowerCase()

  return {
    label: host.startsWith("www.") ? host.slice("www.".length) : host,
    recognised: false,
  }
}
