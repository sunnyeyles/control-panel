"use server"

import { getCurrentUser } from "@/lib/auth/current-user"
import { getDb } from "@/lib/db"
import { createJobActions, type JobActionState } from "@/lib/jobs/job-actions"
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

const actions = createJobActions({
  getUser: getCurrentUser,
  // Resolved per call, inside the action bodies. `getDb()` is memoized, so this
  // is one connection per server instance rather than one per action.
  getJobs: () => getDb().jobs,
})

export async function setJobEnabledAction(
  state: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  const result = await actions.setJobEnabled(state, formData)

  if (result.status === "success") refreshSettings()

  return result
}

export async function updateJobScheduleAction(
  state: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  const result = await actions.updateJobSchedule(state, formData)

  if (result.status === "success") refreshSettings()

  return result
}

export async function createJobAction(
  state: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  const result = await actions.createJob(state, formData)

  if (result.status === "success") refreshSettings()

  return result
}

/**
 * `refresh()`, and it is not optional here.
 *
 * `next.config.ts` sets `staleTimes.dynamic: 30`, which lets the client router
 * reuse this segment for half a minute. Without this call a switch the user
 * just turned off would come back on when they navigated away and back — the
 * cached segment outliving the change that made it stale. The same reasoning as
 * the documents actions, which is what makes that setting safe at all.
 */
function refreshSettings(): void {
  refresh()
}
