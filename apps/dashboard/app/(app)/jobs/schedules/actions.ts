"use server"

import type { ActionState } from "@/lib/actions/action-state"
import { getCurrentUser } from "@/lib/auth/current-user"
import { getPrisma } from "@/lib/db"
import type {
  CriteriaSuggestionState,
  RoleTitleSuggestionState,
} from "@/lib/jobs/criteria-suggestion"
import { createJobActions } from "@/lib/jobs/job-actions"
import { createSuggestCriteriaActions } from "@/lib/jobs/suggest-criteria-actions"
import { createTitleFilterActions } from "@/lib/postings/title-filter-actions"
import { getResumeStore } from "@/lib/storage"
import { refresh } from "next/cache"

/**
 * The briefing actions, following the convention
 * `app/(app)/documents/actions.ts` sets — see its docblock for the six rules.
 * In short: `"use server"` at the top of a dedicated file so the set of POST
 * endpoints is auditable in one place, a thin wrapper over a
 * `createXActions(deps)` factory in `lib/` that imports no Next, and cache
 * invalidation here rather than in the core because `refresh()` needs a request
 * store.
 */

/**
 * ⚠️ `refresh()` after every success is not optional: `staleTimes.dynamic: 30`
 * means a switch the user just turned off comes back on when they navigate away
 * and back. It takes no path and clears the client router cache, so it covers
 * this segment and `/jobs` alike — which matters, since the postings page reads
 * the same rows for its briefing strip and empty state.
 */
const actions = createJobActions({
  getUser: getCurrentUser,
  // Resolved per call, inside the action bodies. `getPrisma()` is memoized, so
  // this is one client per server instance rather than one per action.
  getPrisma,
})

export async function setJobEnabledAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.setJobEnabled(state, formData)

  if (result.status === "success") refresh()

  return result
}

export async function updateJobScheduleAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.updateJobSchedule(state, formData)

  if (result.status === "success") refresh()

  return result
}

export async function createJobAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.createJob(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Changing what an existing briefing searches for.
 *
 * `refresh()` for the reason `saveTitleFiltersAction` gives, more sharply: the
 * edit form renders stored criteria as `defaultValue`s off a server render, so
 * without it the pre-save titles come back on the next visit — a save that
 * looks like it silently did not happen.
 */
export async function updateJobCriteriaAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.updateJobCriteria(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * The account-wide title filter.
 *
 * Here rather than in `jobs/page.tsx`'s own actions because the form is on this
 * page — the exported action set of a segment is a security surface, and it is
 * auditable when it is the things *this* page can do.
 */
const titleFilters = createTitleFilterActions({
  getUser: getCurrentUser,
  getPrisma,
})

/**
 * ⚠️ **`refresh()` matters more here than for the actions above.** The form
 * renders saved terms as a `defaultValue`, so without it the pre-save list
 * comes back on the next visit. It also makes `/jobs` re-query: the filter
 * decides which rows that page shows, and a stale segment there would keep
 * showing the postings the user just hid.
 */
export async function saveTitleFiltersAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await titleFilters.saveTitleFilters(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Reading proposed search criteria out of the user's uploaded CV, for the
 * new-briefing form to render into its own fields.
 *
 * ⚠️ The extractor is deliberately *not* supplied: the factory's default
 * constructs a model that reads `OPENAI_API_KEY`, which must not happen at
 * module scope in a file every render of this page imports.
 */
const suggestCriteria = createSuggestCriteriaActions({
  getUser: getCurrentUser,
  getResumes: getResumeStore,
  getPrisma,
})

/**
 * ⚠️ **No `refresh()`, unlike every other action here — deliberate, not
 * forgotten.** This writes nothing; `createJobAction` is what writes the row
 * and invalidates. Calling `refresh()` anyway would re-render the segment the
 * suggestion is meant to be filling in, throwing away the name and schedule the
 * user already typed. Restoring it "for consistency" is the change this comment
 * exists to stop.
 */
export async function suggestCriteriaAction(
  state: CriteriaSuggestionState,
  formData: FormData
): Promise<CriteriaSuggestionState> {
  return suggestCriteria.suggestCriteria(state, formData)
}

/**
 * Proposing the role titles adjacent to the ones already chosen.
 *
 * **No `refresh()`, for the reason above** — it writes nothing, and calling it
 * would throw away the half-filled form the answer is offered into. The
 * suggester, like the extractor, is left to the factory's default.
 */
export async function suggestRoleTitlesAction(
  state: RoleTitleSuggestionState,
  formData: FormData
): Promise<RoleTitleSuggestionState> {
  return suggestCriteria.suggestRoleTitles(state, formData)
}
