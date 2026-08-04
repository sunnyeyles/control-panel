import { z } from "zod"

/**
 * The minimum `jobs.config` a briefing needs in order to run at all.
 *
 * ⚠️ **This duplicates part of a schema that lives somewhere else, knowingly.**
 * The authority is `JobSearchConfigSchema` in
 * `apps/briefing-worker/src/job-search-config.ts`, and the platform's rule is
 * that `jobs.config` is opaque to `@workspace/db` — "the platform stores that
 * column and never reads inside it, so the meaning lives with whatever runs the
 * job". The dashboard cannot import that schema: it lives in an app, and apps do
 * not depend on apps.
 *
 * Duplicating it anyway, rather than writing `{}`, because the worker's schema
 * requires `titles` and `locations` with at least one entry each — so a job
 * created without them is not "a job with no criteria yet", it is a job whose
 * first run is guaranteed to fail with *"has a config this worker cannot read"*,
 * having already claimed and burned its slot.
 *
 * **`keywords` is the one field here the worker does *not* require, and it is
 * worth the extra duplication for two reasons.** It is the field a CV yields
 * most clearly — a resume states technologies plainly and states a desired
 * location almost never — so the "suggest criteria from my resume" flow has a
 * list of technologies in hand and nowhere to put it unless this schema accepts
 * one. And without a field here, that list would stop at the form: the scout is
 * told what to look for from `jobs.config` alone, so a keyword the dashboard
 * drops is a keyword the scout never sees. Duplicating one optional field is
 * cheaper than an extracted technology list that reaches nothing.
 *
 * `exclude`, `sources` and `maxPostings` stay out: nothing in the app collects
 * them, so leaving them out costs nothing and keeps the overlap as small as it
 * can be. The real fix is to lift that module into a shared package; until then,
 * changing the worker's required fields means changing this file too.
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
 * A comma-separated field as the array the worker expects.
 *
 * Comma-separated rather than a repeated input because these are short phrases
 * a person types in one go — "senior backend engineer, staff engineer" — and a
 * tag editor is a lot of component for a field that is read once a day.
 */
const criteriaList = z
  .string()
  .transform(splitCriteria)
  .pipe(z.array(z.string().min(1)).min(1).max(MAX_CRITERIA_ITEMS))

/**
 * The same field where having nothing to say is a legitimate answer.
 *
 * `.min(1)` is the whole difference in the array, but the input side has to be
 * wider too. This is parsed straight out of a `FormData`, and a form field that
 * was never posted comes back as `null`, not as `undefined` and not as `""` —
 * so a schema that only accepted `string` would turn "the user left keywords
 * empty" into "the whole create failed", which is precisely the outcome an
 * optional field exists to avoid. `undefined` is accepted for the same reason
 * one step further out: a caller that simply omits the key means the same
 * thing.
 *
 * All three, plus a whitespace- or comma-only string, parse to `[]`. That makes
 * `[]` the single representation of "none", which is what lets the caller test
 * one thing when deciding whether to write the field at all.
 */
const optionalCriteriaList = z
  .string()
  .nullish()
  .transform((value) => splitCriteria(value ?? ""))
  .pipe(z.array(z.string().min(1)).max(MAX_CRITERIA_ITEMS))

export const searchCriteriaSchema = z.object({
  titles: criteriaList,
  locations: criteriaList,
  keywords: optionalCriteriaList,
})
