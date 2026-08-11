import {
  JobSearchConfigSchema,
  type JobSearchConfig,
} from "@workspace/job-search"
import { z } from "zod"

/**
 * The minimum `jobs.config` a briefing needs in order to run at all.
 *
 * The authority is `JobSearchConfigSchema` in `@workspace/job-search`, and
 * the field schemas below are *taken from it* rather than restated — the
 * worker requires `titles` and `locations` with at least one entry each, so a
 * job created without them is not "a job with no criteria yet", it is a job
 * whose first run is guaranteed to fail with *"has a config this worker
 * cannot read"*, having already claimed and burned its slot. What this module
 * adds is the form's own concerns: the comma-split, the null-tolerant
 * optional field, and a paste bound.
 *
 * **`keywords` is the one optional *list* the form collects, deliberately.**
 * It is the field a CV yields most clearly — a resume states technologies
 * plainly and states a desired location almost never — so the "suggest
 * criteria from my resume" flow has a list of technologies in hand and
 * nowhere to put it unless this schema accepts one. `exclude` and `sources`
 * stay out: nothing in the app collects them.
 *
 * **`maxPostings` is collected because not collecting it was a bug.** The field
 * has always existed in the worker's schema and nothing ever wrote it, so every
 * briefing in production ran on the default and there was no way to ask for more
 * — which is what made "some runs come back with almost nothing" partly a
 * question about this form. It is a number rather than a list, so it gets its own
 * input shape below.
 *
 * The check at the foot of this file is what the old duplication could never
 * give: if the worker's required set grows, this module stops compiling
 * instead of the next run failing tomorrow morning.
 */

/** Generous, and only there so one paste cannot write an unbounded row. */
export const MAX_CRITERIA_ITEMS = 20

/**
 * The split itself, shared by the required and optional lists so the two cannot
 * come to disagree about what "comma separated" means — a field that trimmed
 * differently from its neighbour would be a bug nobody would think to look for.
 *
 * Dropping the empty entries here is what makes `""`, `"   "` and `",,"` all
 * arrive as `[]` rather than as a list of blanks.
 */
function splitCriteria(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * A comma-separated field as the array the worker expects — piped into the
 * *worker's own* field schema, so its bounds cannot drift from the authority.
 *
 * Comma-separated rather than a repeated input because these are short phrases
 * a person types in one go — "senior backend engineer, staff engineer" — and a
 * tag editor is a lot of component for a field that is read once a day.
 */
const criteriaList = z
  .string()
  .transform(splitCriteria)
  .pipe(JobSearchConfigSchema.shape.titles.max(MAX_CRITERIA_ITEMS))

/**
 * The same field where having nothing to say is a legitimate answer.
 *
 * The `.min(1)` the required list carries is the whole difference in the
 * array, but the input side has to be wider too. This is parsed straight out
 * of a `FormData`, and a form field that was never posted comes back as
 * `null`, not as `undefined` and not as `""` — so a schema that only accepted
 * `string` would turn "the user left keywords empty" into "the whole create
 * failed", which is precisely the outcome an optional field exists to avoid.
 * `undefined` is accepted for the same reason one step further out: a caller
 * that simply omits the key means the same thing.
 *
 * All three, plus a whitespace- or comma-only string, parse to `[]`. That makes
 * `[]` the single representation of "none", which is what lets the caller test
 * one thing when deciding whether to write the field at all.
 */
const optionalCriteriaList = z
  .string()
  .nullish()
  .transform((value) => splitCriteria(value ?? ""))
  .pipe(JobSearchConfigSchema.shape.keywords.unwrap().max(MAX_CRITERIA_ITEMS))

/**
 * How many postings to ask for, or nothing at all.
 *
 * A `FormData` field is a string however numeric the input is, and the three
 * ways of saying "I did not choose" — never posted (`null`), left blank (`""`),
 * and whitespace — all have to become `undefined` rather than `0` or `NaN`.
 * `Number("")` is `0`, which the worker's schema would reject with a message
 * about a minimum, so the blank case is answered before a number is read at all.
 *
 * Piped into the worker's own field, so the bounds cannot drift from the
 * authority — `"40"` fails here because the *scout* cannot honestly report forty
 * postings, and that is a fact about the pipeline rather than about this input.
 */
const optionalPostingCount = z
  .string()
  .nullish()
  .transform((value) => value?.trim() ?? "")
  .transform((value) => (value === "" ? undefined : Number(value)))
  .pipe(JobSearchConfigSchema.shape.maxPostings)

export const searchCriteriaSchema = z.object({
  titles: criteriaList,
  locations: criteriaList,
  keywords: optionalCriteriaList,
  maxPostings: optionalPostingCount,
})

/**
 * ⚠️ **The drift alarm.** What this form produces must be a config the worker
 * can read; if `JobSearchConfigSchema` ever grows a new *required* field, the
 * assignment below stops compiling, and whoever widened the worker's contract
 * is pointed at the form that has to start collecting the field.
 */
type FormCriteria = z.infer<typeof searchCriteriaSchema>
const _formOutputSatisfiesWorkerConfig = (
  criteria: FormCriteria
): JobSearchConfig => criteria
void _formOutputSatisfiesWorkerConfig
