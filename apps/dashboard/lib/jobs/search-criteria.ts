import {
  JobSearchConfigSchema,
  type JobSearchConfig,
} from "@workspace/job-search"
import { z } from "zod"

import { MAX_ROLE_TITLES, splitCriteria } from "./criteria-text"

/**
 * The minimum `jobs.config` a briefing needs in order to run at all.
 *
 * The authority is `JobSearchConfigSchema` in `@workspace/job-search`, and the
 * field schemas below are *taken from it* rather than restated — a job created
 * without `titles` and `locations` is not "a job with no criteria yet", it is
 * one whose first run fails after claiming and burning its slot. What this
 * module adds is the form's concerns: the comma-split, the null-tolerant
 * optional field, and a paste bound.
 *
 * `keywords` is the one optional *list* collected, because a CV yields
 * technologies plainly and a desired location almost never; `exclude` and
 * `sources` stay out since nothing collects them. `maxPostings` is collected
 * because nothing ever wrote it, so every briefing ran on the default with no
 * way to ask for more.
 *
 * The check at the foot of the file is the point: if the worker's required set
 * grows, this stops compiling instead of failing tomorrow morning.
 */

/** Generous, and only there so one paste cannot write an unbounded row. */
export const MAX_CRITERIA_ITEMS = 20

/**
 * A comma-separated field as the array the worker expects — piped into the
 * *worker's own* field schema, so its bounds cannot drift from the authority.
 *
 * **Still comma-separated text, now with a completion behind it.** The
 * completion and suggestion rows in `role-title-field.tsx` are all ways of
 * producing the same string, so the posted field, this schema and the Server
 * Action are untouched by any of it.
 *
 * ⚠️ `splitCriteria` lives in `criteria-text.ts` because the client needs it
 * too and this module cannot be reached from a browser bundle — it imports
 * `@workspace/job-search`, whose barrel pulls in LangChain.
 */
const criteriaList = z
  .string()
  .transform(splitCriteria)
  .pipe(JobSearchConfigSchema.shape.titles.max(MAX_CRITERIA_ITEMS))

/**
 * Role titles, which are capped far lower than everything else.
 *
 * The fan-out is why — see {@link MAX_ROLE_TITLES}. Locations multiply the same
 * way and are bounded here only by the paste guard, because the *combination*
 * is what the form checks: `fitsSearchBudget` gates the submit button, and this
 * is the half a direct POST still has to get past.
 *
 * ⚠️ **`JobSearchConfigSchema` is deliberately not narrowed to match.** An
 * existing briefing with five titles keeps running; it just cannot be re-saved
 * from the form without being trimmed first.
 */
const titleList = z
  .string()
  .transform(splitCriteria)
  .pipe(JobSearchConfigSchema.shape.titles.max(MAX_ROLE_TITLES))

/**
 * The same field where having nothing to say is a legitimate answer.
 *
 * ⚠️ Parsed straight out of a `FormData`, where a field that was never posted
 * comes back as `null` — not `undefined`, not `""`. A `string`-only schema
 * would turn "left keywords empty" into "the whole create failed". `undefined`
 * is accepted for the same reason: an omitted key means the same thing.
 *
 * All three, plus a whitespace- or comma-only string, parse to `[]`, so `[]` is
 * the single representation of "none".
 */
const optionalCriteriaList = z
  .string()
  .nullish()
  .transform((value) => splitCriteria(value ?? ""))
  .pipe(JobSearchConfigSchema.shape.keywords.unwrap().max(MAX_CRITERIA_ITEMS))

/**
 * How many postings to ask for, or nothing at all.
 *
 * ⚠️ A `FormData` field is a string however numeric the input is, and all three
 * ways of saying "I did not choose" — `null`, `""`, whitespace — must become
 * `undefined` rather than `0` or `NaN`. `Number("")` is `0`, which the worker's
 * schema rejects, so the blank case is answered before a number is read.
 *
 * Piped into the worker's own field so the bounds cannot drift: `"40"` fails
 * because the *scout* cannot honestly report forty postings.
 */
const optionalPostingCount = z
  .string()
  .nullish()
  .transform((value) => value?.trim() ?? "")
  .transform((value) => (value === "" ? undefined : Number(value)))
  .pipe(JobSearchConfigSchema.shape.maxPostings)

export const searchCriteriaSchema = z.object({
  titles: titleList,
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
