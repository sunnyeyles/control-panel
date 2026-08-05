import { postingId, type Findings } from "@workspace/agents"
import type { NewPosting } from "@workspace/db"

/**
 * What the scout found, as rows the cumulative record can hold.
 *
 * **This is the one place `@workspace/agents` and `@workspace/db` meet**, and
 * that is why it is a module of its own. `packages/db` takes an opaque
 * {@link NewPosting} and never imports the agent stack — the platform stores a
 * Posting and does not interpret one, exactly as it treats `jobs.config` and
 * `runs.findings` — so something has to translate, and putting the translation
 * here is what keeps that dependency pointing one way.
 *
 * Pure, and deliberately so: no clock, no database, no id of its own. The
 * sighting time and the Run that saw them are the caller's to supply, because
 * the callers mean different instants — the worker passes the Run's slot, the
 * backfill each historic Run's `started_at`.
 */

/**
 * Project each validated Posting onto a row, keeping the whole of it.
 *
 * Two things here are load-bearing:
 *
 * 1. **The id comes from `postingId()`, never from a rule restated here.** It
 *    is a SHA-256 of a *normalised* URL — tracking parameters dropped,
 *    survivors sorted, default port removed, trailing slash stripped — and it
 *    is what two Runs a week apart use to agree they found the same
 *    advertisement. A second implementation disagreeing by one rule would mint
 *    ids nothing else agrees with, splitting one Posting into two rows and
 *    stranding the status a person set on the first.
 * 2. **`payload` is the Posting verbatim**, including the fields the four
 *    projected columns leave out — `highlights`, `summary`, `matchReason`,
 *    `postedAt`. Those columns exist to sort and display on; the payload is
 *    what a reader, and the cover-letter writer, is given.
 *
 * **Duplicates are not merged here.** Two postings whose URLs normalise to the
 * same id come back as two rows carrying that id, and `recordPostings`
 * collapses them: the hazard is Postgres raising `21000` for a statement that
 * touches one row twice, so it is fixed where the statement is. Merging here
 * instead would leave the backfill, which calls the same helper, unprotected.
 */
export function toNewPostings(findings: Findings): NewPosting[] {
  return findings.postings.map((posting) => ({
    postingId: postingId(posting),
    title: posting.title,
    company: posting.company,
    location: posting.location,
    url: posting.url,
    payload: posting,
  }))
}
