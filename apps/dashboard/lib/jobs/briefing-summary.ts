import type { Job } from "@workspace/db"

import { formatInStoredZone } from "@/lib/format-dates"

import { describeInterval, fromCron, type IntervalHours } from "./interval"

/**
 * One briefing, flattened to strings for rendering.
 *
 * Every field is a `string`, `number` or `boolean` — deliberately, and the
 * reason is the one `components/documents/document-list.tsx` gives: a `Date`
 * formatted in a client component uses the browser's locale and timezone, which
 * will not match the server's, and React reports that as a hydration mismatch
 * rather than as the timezone bug it is. `Job.nextRunAt` is a `Date`, so it
 * cannot cross into a client component at all.
 *
 * The `Job` import is type-only and therefore erased, so a client component may
 * import this type without pulling `@workspace/db` into the browser bundle.
 */
export interface BriefingSummary {
  id: string
  name: string
  /**
   * `jobs.next_run_at IS NOT NULL`, and there is nothing else to read.
   *
   * The schema has no `enabled` column on purpose — one column carries both
   * "when next" and "whether at all".
   */
  enabled: boolean
  /**
   * The interval the picker should preselect, or `undefined` when the stored
   * expression is not one the picker can express.
   *
   * `undefined` is not an error state — a row written by hand is perfectly
   * valid — but it does mean saving the form will replace whatever is there,
   * which is why the section says so rather than letting it happen quietly.
   */
  intervalHours?: IntervalHours
  /** The schedule as a sentence, or the raw expression when it has no interval. */
  schedule: string
  /** The next occurrence, or undefined when the briefing is off. */
  nextRun?: string
}

export function toBriefingSummary(job: Job): BriefingSummary {
  const intervalHours = fromCron(job.scheduleCron)

  return {
    id: job.id,
    name: job.name,
    enabled: job.nextRunAt !== null,
    ...(intervalHours ? { intervalHours } : {}),
    schedule: intervalHours
      ? describeInterval(intervalHours)
      : job.scheduleCron,
    ...(job.nextRunAt
      ? { nextRun: formatInStoredZone(job.nextRunAt, job.scheduleTimezone) }
      : {}),
  }
}
