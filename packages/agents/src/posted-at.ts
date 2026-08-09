import { isRealCalendarDate } from "@workspace/user-storage/keys"

/**
 * The rule that turns a Posting's `postedAt` into a point in time.
 *
 * It lives beside {@link ../findings.ts | the Posting contract} because it is
 * part of that contract rather than part of any one producer: `postedAt` is free
 * text by design, and this is the single rule saying which free text is also a
 * date. Two callers need it — the worker projecting a Run's findings onto
 * `postings` rows, and the dashboard doing the same for a Posting somebody added
 * by pasting its link — and a second copy is exactly the drift the docblock
 * below warns about.
 */

/**
 * An ISO-8601 date copied off the page, or nothing.
 *
 * **A Posting's `postedAt` is free text and is meant to be.** Whoever produces
 * one is instructed to reproduce what the advertisement said and to omit the
 * field rather than estimate, so "3 days ago", "Posted yesterday" and an empty
 * field are all ordinary answers rather than failures — and none of them is a
 * point in time. SEEK's actor supplies `publishDateISO`, which is why most of
 * them are.
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
 * re-found. There must not become a third: this module is where the TypeScript
 * copy lives, and both the worker and the dashboard import it from here.
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
