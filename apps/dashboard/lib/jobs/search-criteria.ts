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
 * Only those two fields appear here. `keywords`, `exclude`, `sources` and
 * `maxPostings` are optional to the worker, so leaving them out costs nothing
 * and keeps the overlap as small as it can be. The real fix is to lift that
 * module into a shared package; until then, changing the worker's required
 * fields means changing this file too.
 */

/** Generous, and only there so one paste cannot write an unbounded row. */
export const MAX_CRITERIA_ITEMS = 20

/**
 * A comma-separated field as the array the worker expects.
 *
 * Comma-separated rather than a repeated input because these are short phrases
 * a person types in one go — "senior backend engineer, staff engineer" — and a
 * tag editor is a lot of component for a field that is read once a day.
 */
const criteriaList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
  .pipe(z.array(z.string().min(1)).min(1).max(MAX_CRITERIA_ITEMS))

export const searchCriteriaSchema = z.object({
  titles: criteriaList,
  locations: criteriaList,
})

/**
 * Exactly the shape `parseJobSearchConfig()` will later accept, so the round
 * trip is checked by the worker's own schema rather than asserted here.
 */
export type SearchCriteria = z.infer<typeof searchCriteriaSchema>
