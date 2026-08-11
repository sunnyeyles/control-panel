import {
  JobSearchConfigSchema,
  type JobSearchConfig,
} from "@workspace/job-search"
import { z } from "zod"

import { MAX_ROLE_TITLES, splitCriteria } from "./criteria-text"

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
 * **`keywords` is the one optional field the form collects, deliberately.**
 * It is the field a CV yields most clearly — a resume states technologies
 * plainly and states a desired location almost never — so the "suggest
 * criteria from my resume" flow has a list of technologies in hand and
 * nowhere to put it unless this schema accepts one. `exclude`, `sources` and
 * `maxPostings` stay out: nothing in the app collects them.
 *
 * The check at the foot of this file is what the old duplication could never
 * give: if the worker's required set grows, this module stops compiling
 * instead of the next run failing tomorrow morning.
 */

/** Generous, and only there so one paste cannot write an unbounded row. */
export const MAX_CRITERIA_ITEMS = 20

/**
 * A comma-separated field as the array the worker expects — piped into the
 * *worker's own* field schema, so its bounds cannot drift from the authority.
 *
 * **Still comma-separated text, now with a completion behind it.** The field
 * used to be plain: short phrases a person types in one go, and the note here
 * said a tag editor was a lot of component for something read once a day. That
 * was right while typing was the only way to fill it. It is no longer the only
 * way — `components/jobs/schedules/role-title-field.tsx` completes the last
 * entry against a checked-in list of role titles and offers two rows of
 * one-click suggestions beside it — and the reason the *storage* shape did not
 * change with it is worth stating: everything above is a way of producing the
 * same string, so the posted field, this schema and the Server Action are
 * untouched by any of it.
 *
 * `splitCriteria` moved to `criteria-text.ts` when that happened, because the
 * client now needs it too and this module cannot be reached from a browser
 * bundle — it imports `@workspace/job-search`, whose barrel pulls in LangChain.
 */
const criteriaList = z
  .string()
  .transform(splitCriteria)
  .pipe(JobSearchConfigSchema.shape.titles.max(MAX_CRITERIA_ITEMS))

/**
 * Role titles, which are capped far lower than everything else.
 *
 * The reason is the fan-out, and it is set out on {@link MAX_ROLE_TITLES}: a
 * run is `titles × locations × boards` searches against a hard model budget,
 * and a briefing over that budget is cut off mid-sweep and reports what it
 * managed — successfully, with no error. Locations multiply the same way and
 * are bounded here only by the paste guard, because the *combination* is what
 * the form checks: `fitsSearchBudget` gates the submit button, and this is the
 * half of the rule a direct POST still has to get past.
 *
 * ⚠️ **`JobSearchConfigSchema` is deliberately not narrowed to match.** An
 * existing briefing with five titles keeps running exactly as it did; what it
 * cannot do is be re-saved from the form without being trimmed first, which the
 * edit form says out loud.
 */
const titleList = z
  .string()
  .transform(splitCriteria)
  .pipe(JobSearchConfigSchema.shape.titles.max(MAX_ROLE_TITLES))

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

export const searchCriteriaSchema = z.object({
  titles: titleList,
  locations: criteriaList,
  keywords: optionalCriteriaList,
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
