/**
 * Every server-side date format the dashboard renders, in one place.
 *
 * ⚠️ Formatted on the server, as strings, because a `Date` crossing into a
 * client component renders differently on the two sides of hydration. A fixed
 * `en-AU` locale, not the runtime's: the server's default is whatever the
 * platform decides, which is neither stable across deploys nor the user's.
 */

const LOCALE = "en-AU"

/**
 * A `Date` as a bare calendar day — "1 Aug 2026" — with no time of day, read
 * in UTC.
 */
export function formatCalendarDate(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}
