/**
 * How often a briefing runs, as a closed set of intervals.
 *
 * Pure — no I/O, no Next, no database — so `interval.test.ts` covers it without
 * any of them.
 *
 * **The interval is the whole schedule model the UI exposes.** There is no time
 * of day, no day of week and no cron field: a briefing repeats every N hours and
 * that is all there is to choose. `jobs.schedule_cron` is still free-form text
 * and the worker still reads a full cron expression — this module is a narrow
 * vocabulary written into that column, not a replacement for it.
 *
 * Two consequences worth knowing:
 *
 * - Rows written by hand, or by an earlier version of this form, can hold
 *   expressions no interval maps to. {@link fromCron} returns `undefined` for
 *   those rather than guessing, so the UI can say what is stored instead of
 *   showing a picker that quietly disagrees with it.
 * - Every interval is a divisor of 24, so slots land on the same hours every
 *   day rather than drifting.
 */

/** The offered intervals, in hours. */
export const INTERVAL_HOURS = [1, 3, 12, 24] as const

export type IntervalHours = (typeof INTERVAL_HOURS)[number]

/** What a new briefing starts on. */
export const DEFAULT_INTERVAL_HOURS: IntervalHours = 24

/**
 * Every schedule is stored in UTC, and no UI offers to change it.
 *
 * For a repeating interval this is the correct answer rather than a shortcut: a
 * zone that observes daylight saving would silently stretch or compress one
 * interval a year, so "every 12 hours" would occasionally mean eleven or
 * thirteen. UTC has no such discontinuity.
 *
 * `schedule_timezone` remains a real column with real meaning — `computeNextRunAt`
 * needs a zone, and a future UI that offers a *time of day* would need a real one
 * — so this is the value this form writes, not a claim that the column is dead.
 */
export const SCHEDULE_TIMEZONE = "UTC"

/**
 * The canonical expression for each interval.
 *
 * `24` is `0 0 * * *` rather than `0 *\/24 * * *`. Both mean midnight — a step
 * of 24 over the 0–23 hour range yields only `0` — but the plain form is what a
 * person reads correctly at a glance in psql.
 */
const CRON_BY_HOURS: Record<IntervalHours, string> = {
  1: "0 * * * *",
  3: "0 */3 * * *",
  12: "0 */12 * * *",
  24: "0 0 * * *",
}

/**
 * Expressions that mean an interval without being the canonical spelling.
 *
 * Read-tolerant, write-canonical: a row holding `0 *\/1 * * *` is recognised as
 * hourly rather than shown as something the picker cannot express, but saving
 * rewrites it to `0 * * * *`.
 */
const HOURS_BY_CRON = new Map<string, IntervalHours>([
  ...Object.entries(CRON_BY_HOURS).map(
    ([hours, cron]) => [cron, Number(hours) as IntervalHours] as const
  ),
  ["0 */1 * * *", 1],
  ["0 */24 * * *", 24],
])

export function isIntervalHours(value: unknown): value is IntervalHours {
  return (INTERVAL_HOURS as readonly unknown[]).includes(value)
}

export function toCron(hours: IntervalHours): string {
  return CRON_BY_HOURS[hours]
}

/**
 * Read a stored expression back as an interval, or `undefined` if none matches.
 *
 * Never throws. Validity is not this function's concern — `isValidSchedule()` in
 * `@workspace/db/schedule` owns that, and an expression can be perfectly valid
 * and still have no interval, which is the case `undefined` is for.
 */
export function fromCron(cron: string): IntervalHours | undefined {
  return HOURS_BY_CRON.get(cron.trim().replace(/\s+/g, " "))
}

/** The label used both in the picker and in the sentence describing a briefing. */
export function describeInterval(hours: IntervalHours): string {
  return hours === 1 ? "Every hour" : `Every ${hours} hours`
}
