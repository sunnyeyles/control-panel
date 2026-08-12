import type { Job } from "@workspace/db"
import { JobSearchConfigSchema } from "@workspace/job-search"

import { formatInStoredZone } from "@/lib/format-dates"

import { describeInterval, fromCron, type IntervalHours } from "./interval"

/**
 * One briefing, flattened to strings for rendering.
 *
 * Every field is a `string`, `number` or `boolean`: a `Date` formatted in a
 * client component uses the browser's locale and timezone, which React reports
 * as a hydration mismatch rather than as the timezone bug it is.
 *
 * ⚠️ **This module must never be imported for a *value* from a client
 * component.** `JobSearchConfigSchema` is a value, and `@workspace/job-search`'s
 * barrel reaches `@workspace/agents` — so reaching for `toBriefingCriteria`
 * from the browser would pull LangChain into the `/jobs/schedules` chunk. Both
 * client callers take a type only; `criteria-text.ts` is the importless half.
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
  /**
   * What this briefing searches for, when `jobs.config` can be read as a
   * job-search config.
   *
   * `undefined` means it could not be — see {@link toBriefingCriteria}. The edit
   * form is what renders this, and its absence is what hides the form.
   */
  criteria?: BriefingCriteriaView
}

/**
 * A briefing's search criteria as the edit form's three fields hold them.
 *
 * Comma-joined here rather than in the component so `criteria-fields.tsx` takes
 * the same shape for a new briefing and an existing one.
 *
 * ⚠️ **`exclude`, `sources` and `maxPostings` are absent, and the edit action
 * *replaces* the config rather than round-tripping it** — `updateJobConfig`
 * writes what it is given, so a row carrying one of those three loses it on the
 * first save from this form.
 */
export interface BriefingCriteriaView {
  titles: string
  locations: string
  keywords: string
}

export function toBriefingSummary(job: Job): BriefingSummary {
  const intervalHours = fromCron(job.scheduleCron)
  const criteria = toBriefingCriteria(job.config)

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
    ...(criteria ? { criteria } : {}),
  }
}

/**
 * `jobs.config` as three editable fields, or `undefined` when it is not a
 * job-search config at all.
 *
 * **`safeParse` and not a throw**: this renders *every* briefing the user has,
 * so one unreadable row must not take the page down. The column is untyped
 * JSONB, so a hand-written row — or a second kind of job with a different
 * config — is legitimate rather than a fault.
 *
 * The card shows such a briefing without an edit form, which is honest: a
 * config this app cannot read is one it must not offer to replace.
 */
function toBriefingCriteria(config: unknown): BriefingCriteriaView | undefined {
  const parsed = JobSearchConfigSchema.safeParse(config)
  if (!parsed.success) return undefined

  return {
    titles: parsed.data.titles.join(", "),
    locations: parsed.data.locations.join(", "),
    keywords: (parsed.data.keywords ?? []).join(", "),
  }
}
