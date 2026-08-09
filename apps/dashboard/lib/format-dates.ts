/**
 * Every server-side date format the dashboard renders, in one place.
 *
 * Formatted on the server, as strings, because a `Date` crossing into a client
 * component renders differently on the two sides of hydration. A fixed
 * `en-AU` locale, not the runtime's: the server's default locale is whatever
 * the platform decides, which is neither stable across deploys nor the
 * user's. Those two rules used to be restated beside each of four private
 * copies of this file's functions; they hold for all of them.
 *
 * What stays distinct is the zone policy — each function names its own,
 * deliberately: a value that is a calendar day renders in UTC with no time, a
 * provenance instant renders in UTC with the zone named, a schedule renders
 * in the job's own stored zone, and run activity renders in Sydney time.
 */

const LOCALE = "en-AU"

/**
 * A `Date` as a bare calendar day — "1 Aug 2026" — with no time of day.
 *
 * Used wherever a value is a day rather than an instant — a posting's stated
 * posting date, a document's upload date — so two unrelated columns rendering
 * the same kind of value don't drift into two slightly different formats.
 */
export function formatCalendarDate(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

/**
 * A UTC datetime for provenance shown on the Postings page.
 *
 * Shared so sighting times (`list-postings`) and document draft times (the
 * rows modules) cannot drift. The zone is named in the output — a time with
 * no zone beside it reads as local and is wrong by hours.
 */
export function formatUtcDateTime(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date)
}

/**
 * A schedule occurrence in the job's own stored zone, zone named beside it.
 *
 * New briefings are all written in UTC — see `SCHEDULE_TIMEZONE` — so a next
 * run reading "10:00" with no zone beside it would be read as local time and
 * be wrong by hours.
 *
 * The `try` is not defensive padding. `Intl` throws a `RangeError` on a zone
 * it does not recognise, and while `createJob()` and `updateJobSchedule()`
 * both validate, a row inserted by hand in psql has been through neither —
 * and an unrecognised zone should not take down the whole schedules page.
 */
export function formatInStoredZone(date: Date, timeZone: string): string {
  try {
    return formatOccurrence(date, timeZone)
  } catch {
    return `${formatOccurrence(date, "UTC")} (UTC)`
  }
}

function formatOccurrence(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
    timeZone,
  }).format(date)
}

/** A run instant as the activity feed shows it, in Sydney time. */
export function formatRunTime(at: Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(at)
}
