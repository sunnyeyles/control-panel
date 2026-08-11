import type { Job } from "@workspace/db"
import { JobSearchConfigSchema } from "@workspace/job-search"

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
 * The `Job` import is type-only and therefore erased. ⚠️ **`JobSearchConfigSchema`
 * is not** — it is a value, and `@workspace/job-search`'s barrel reaches
 * `@workspace/agents`, so **this module must never be imported for a value from
 * a client component**. Both of the ones that touch it take a type only
 * (`import type { BriefingSummary }`, `import type { BriefingCriteriaView }`),
 * and the one caller of `toBriefingSummary` is a server component. Reaching for
 * `toBriefingCriteria` from the browser would pull LangChain into the
 * `/jobs/schedules` chunk; `lib/jobs/criteria-text.ts` exists to be the
 * importless half for exactly that reason.
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
 * Comma-joined here rather than in the component so the projection is one
 * function rather than three `join` calls in JSX, and so `criteria-fields.tsx`
 * takes the same shape whether it is filling a new briefing or an existing one.
 *
 * `exclude`, `sources` and `maxPostings` are deliberately absent: no form
 * collects them, and projecting a field the form cannot edit would make the
 * edit action look like it round-trips the whole config when it replaces it.
 * ⚠️ **It does replace it** — `updateJobConfig` writes what it is given — so a
 * briefing whose row carries one of those three loses it on the first save from
 * this form. That is worth knowing before somebody adds one by hand.
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
 * **`safeParse` and not a throw**, which is the same call `parsePostingQuery`
 * makes about a hand-edited URL and for a neighbouring reason: this runs inside
 * a server component rendering *every* briefing the user has, so one
 * unreadable row must not take the page down with it. The column is untyped
 * JSONB and the platform never reads inside it, so a row written by hand, or by
 * a second kind of job that arrives later with a completely different config,
 * is a legitimate thing to find here rather than a fault.
 *
 * What the card does with `undefined` is show the briefing without an edit
 * form — which is honest: a config this app cannot read is one it must not
 * offer to replace with three text boxes.
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
