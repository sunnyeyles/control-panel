/**
 * A fixed en-AU / UTC datetime for provenance shown on the Postings page.
 *
 * Shared so sighting times (`list-postings`) and cover-letter draft times
 * (`cover-letter-rows`) cannot drift: a fixed locale (the server's default is
 * whatever the platform decides) and an explicit zone named in the output —
 * UTC, because a time with no zone beside it reads as local and is wrong by
 * hours.
 */
export function formatUtcDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
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
