import { postingId, type Findings } from "@workspace/agents"
import type { NewPosting } from "@workspace/db"
import { isRealCalendarDate } from "@workspace/user-storage/keys"

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
 * 2. **`payload` is the Posting verbatim**, including the fields the projected
 *    columns leave out — `highlights`, `summary`, `matchReason` — and including
 *    `postedAt` as the advertisement's own words even though a column now holds
 *    the parsed form of it. The columns exist to sort and display on; the
 *    payload is what a reader, and the cover-letter writer, is given, and it
 *    stays the record of what the page actually said.
 *
 * **Duplicates are not merged here.** Two postings whose URLs normalise to the
 * same id come back as two rows carrying that id, and `recordPostings`
 * collapses them: the hazard is Postgres raising `21000` for a statement that
 * touches one row twice, so it is fixed where the statement is. Merging here
 * instead would leave the backfill, which calls the same helper, unprotected.
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

/**
 * An ISO-8601 date the scout copied off the page, or nothing.
 *
 * **The scout's `postedAt` is free text and is meant to be.** It is instructed
 * to reproduce what the advertisement said and to omit the field rather than
 * estimate, so "3 days ago", "Posted yesterday" and an empty field are all
 * ordinary answers rather than failures — and none of them is a point in time.
 * SEEK's actor supplies `publishDateISO`, which is why most of them are.
 *
 * ⚠️ **Refusing anything that is not ISO-shaped is the whole function**, and a
 * looser rule is the bug it exists to prevent. `new Date("Yesterday")` is
 * invalid and would be caught, but `new Date("March 2026")` is not, and neither
 * is Postgres's own reading of `'yesterday'` — both would invent a day the
 * advertisement never named and put it in a column the table sorts by. A
 * fabricated date is worse than no date, because no date is visibly no date:
 * the column renders the advertisement's own words and the order pins it last.
 *
 * The same rule is restated as a regex in
 * `packages/db/prisma/migrations/0006_posting_posted_at/migration.sql`, which
 * backfilled the rows that predate this column. The two must not drift, or one
 * advertisement sorts differently depending on whether it was backfilled or
 * re-found.
 */
export function parsePostedAt(value: string | undefined): Date | undefined {
  // A bare `YYYY-MM-DD`, or a datetime that names its own offset, and nothing
  // else.
  //
  // ⚠️ **The offset is not optional, and that is the whole reason for the
  // second half of this pattern.** `new Date` reads a date-*time* carrying no
  // offset in the machine's zone and Postgres reads it in the database's, so
  // `2026-08-01T09:30` is a different instant depending on which side wrote the
  // row — a worker run from a laptop in `Australia/Sydney` would store 31 July
  // for an advertisement that said 1 August. Both offset-less forms are refused
  // for that reason: the space-separated one, and the `T` one. A bare date is
  // the only exception and needs none, because both sides read it as UTC.
  if (
    value === undefined ||
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})|$)/.test(
      value
    )
  ) {
    return undefined
  }

  // ⚠️ `new Date("2026-02-30")` does not fail — it rolls forward to 2 March.
  // Inventing a day the advertisement never named is precisely what this
  // function exists to prevent, and the parse alone does not catch it, so the
  // day is checked against `@workspace/user-storage`'s `isRealCalendarDate`
  // rather than a second copy of the same rebuild-and-compare technique.
  if (!isRealCalendarDate(value.slice(0, 10))) return undefined

  const parsed = new Date(value)

  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}
