/**
 * A `Date` as a bare calendar day — "1 Aug 2026" — with no time of day.
 *
 * A fixed locale and an explicit zone, not the runtime's: the server's default
 * locale is whatever the platform decides, which is neither stable across
 * deploys nor the user's, and a date with no zone named beside it would read
 * as local when it is UTC. Used wherever a value is a day rather than an
 * instant — a posting's stated posting date, a document's upload date — so
 * two unrelated columns rendering the same kind of value don't drift into
 * two slightly different formats.
 */
export function formatCalendarDate(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}
