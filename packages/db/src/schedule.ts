import { CronExpressionParser } from "cron-parser"

import { InvalidScheduleError } from "./errors.js"

/**
 * When a job should next run, given its cadence and a moment to look forward
 * from.
 *
 * Application code, not a trigger and not a generated column. Postgres cannot
 * parse cron without an extension, so keeping this in SQL would mean putting
 * the most bug-prone logic in the system — DST arithmetic across IANA zones —
 * where there is no test runner, no type checker and no reviewer. The DST cases
 * beside this file in `schedule.test.ts` are the entire argument.
 *
 * What buys back the guarantee a trigger would have given: every writer goes
 * through `@workspace/db`, because there is no generic query surface for one to
 * go around. A hand-run `UPDATE` in psql can still break the invariant, which
 * is accepted and is the same exposure the conditional-`UPDATE` transition rule
 * already carries.
 *
 * Called in exactly three places, and all three are in this package:
 *
 * 1. On insert, so no job is ever born unscheduled by accident.
 * 2. On a schedule edit, in the same statement — the failure this guards is a
 *    job whose cron was changed but which silently keeps firing on the old one.
 * 3. In the claim transaction, advancing past every missed slot to the next
 *    future occurrence.
 *
 * @param cron  A 5-field crontab expression, or 6 with leading seconds.
 * @param timezone  An IANA zone name. Never an offset — an offset cannot
 *   express "09:00 local, on both sides of a DST transition".
 * @param after  The instant to search forward from, exclusive. Passing `now`
 *   is what produces **one** next occurrence rather than a backfill queue: a
 *   job that missed three days runs once and jumps forward, it does not owe
 *   three runs.
 * @throws {InvalidScheduleError} if the expression or zone cannot produce one.
 */
export function computeNextRunAt(
  cron: string,
  timezone: string,
  after: Date
): Date {
  const expression = assertCron(cron)
  const tz = assertTimezone(timezone)

  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    throw new InvalidScheduleError(
      `\`after\` must be a valid Date (got ${JSON.stringify(after)}).`
    )
  }

  try {
    // `next()` is strictly after `currentDate`, which is what makes an
    // already-claimed slot impossible to hand out twice: claiming at exactly
    // the slot instant advances to the following one.
    return CronExpressionParser.parse(expression, {
      currentDate: after,
      tz,
    })
      .next()
      .toDate()
  } catch (cause) {
    throw new InvalidScheduleError(
      `"${cron}" in ${timezone} has no next occurrence after ${after.toISOString()}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    )
  }
}

/**
 * Whether a schedule can be stored at all.
 *
 * The parse *is* the validation — there is no CHECK on `schedule_cron` and
 * there could not be one — so this is just {@link computeNextRunAt} asked as a
 * yes/no question, for a form that wants to reject input before submitting it.
 */
export function isValidSchedule(cron: string, timezone: string): boolean {
  try {
    computeNextRunAt(cron, timezone, new Date())
    return true
  } catch {
    return false
  }
}

/**
 * Reject the expressions the parser is too generous about.
 *
 * `cron-parser` treats an empty string, and any expression with fewer than five
 * fields, as a wildcard — so `""` silently means *every minute*. A job stored
 * that way would be due at every tick forever, and each tick is a paid LLM run.
 * Loud is better.
 */
function assertCron(cron: string): string {
  const trimmed = typeof cron === "string" ? cron.trim() : ""
  const fields = trimmed.length > 0 ? trimmed.split(/\s+/) : []

  if (fields.length < 5 || fields.length > 6) {
    throw new InvalidScheduleError(
      `A cron expression needs 5 fields (minute hour day-of-month month day-of-week), or 6 with leading seconds — got ${fields.length} in ${JSON.stringify(cron)}.`
    )
  }

  return trimmed
}

/**
 * An unknown zone does not fail at parse time — it fails later, deep in date
 * arithmetic, as `unhandled timestamp: Invalid Date`. Checking here is what
 * turns that into a message naming the zone.
 */
function assertTimezone(timezone: string): string {
  const trimmed = typeof timezone === "string" ? timezone.trim() : ""

  if (!trimmed) {
    throw new InvalidScheduleError(
      'A timezone is required; use "UTC" if the schedule has no local meaning.'
    )
  }

  // Rejected explicitly, because `Intl` accepts them. A fixed offset is a
  // perfectly valid `timeZone` to Node and a broken schedule to us: "09:00
  // +10:00" means 08:00 local for half the year in a zone that observes DST,
  // which is precisely what the column exists to avoid. Only a zone name
  // carries the rules.
  if (/^[+-]/.test(trimmed)) {
    throw new InvalidScheduleError(
      `"${timezone}" is a UTC offset, not a timezone. An offset cannot express a schedule that holds across a DST transition — use an IANA name such as "Australia/Sydney".`
    )
  }

  try {
    // Throws RangeError for anything Node's ICU does not recognise.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed })
  } catch (cause) {
    throw new InvalidScheduleError(
      `"${timezone}" is not an IANA timezone name (e.g. "UTC", "Australia/Sydney").`,
      { cause }
    )
  }

  return trimmed
}
