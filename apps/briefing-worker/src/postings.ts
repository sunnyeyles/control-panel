import { parsePostedAt, postingId, type Findings } from "@workspace/agents"
import type { NewPosting } from "@workspace/db"

/**
 * What the scout found, as rows the cumulative record can hold.
 *
 * **The one place `@workspace/agents` and `@workspace/db` meet**, which is why
 * it is its own module: `packages/db` takes an opaque {@link NewPosting} and
 * never imports the agent stack, so the translation lives here and the
 * dependency keeps pointing one way.
 *
 * Pure by design — no clock, no database, no id of its own. The sighting time
 * is the caller's to supply, because the callers mean different instants: the
 * worker passes the Run's slot, the backfill each historic Run's `started_at`.
 */

/**
 * Project each validated Posting onto a row, keeping the whole of it.
 *
 * Two things are load-bearing:
 *
 * 1. **The id comes from `postingId()`, never from a rule restated here** — a
 *    second implementation disagreeing by one rule would split one Posting into
 *    two rows and strand the status a person set on the first.
 * 2. **`payload` is the Posting verbatim**, including fields no column holds
 *    and `postedAt` in the advertisement's own words. The columns are for
 *    sorting and display; the payload is the record of what the page said.
 *
 * **Duplicates are not merged here.** `recordPostings` collapses them, because
 * the hazard is Postgres `21000` for a statement touching one row twice —
 * fixing it there also covers the backfill, which calls the same helper.
 */
export function toNewPostings(findings: Findings): NewPosting[] {
  return findings.postings.map((posting) => {
    const postedAt = parsePostedAt(posting.postedAt)

    return {
      postingId: postingId(posting),
      title: posting.title,
      company: posting.company,
      location: posting.location,
      url: posting.url,
      postedAt,
      payload: posting,
    }
  })
}
