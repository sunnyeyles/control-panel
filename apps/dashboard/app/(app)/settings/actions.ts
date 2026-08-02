"use server"

import { getCurrentUser } from "@/lib/auth/current-user"
import { getDb } from "@/lib/db"
import type { ActionState } from "@/lib/actions/action-state"
import { createJobActions } from "@/lib/jobs/job-actions"
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
 * `refresh()` after every success is not optional here. `next.config.ts` sets
 * `staleTimes.dynamic: 30`, so without it a switch the user just turned off
 * comes back on when they navigate away and back — the cached segment outliving
 * the change that made it stale. `documents/actions.ts` explains why it is
 * `refresh()` rather than `revalidatePath` or `revalidateTag`.
 */
const actions = createJobActions({
  getUser: getCurrentUser,
  // Resolved per call, inside the action bodies. `getDb()` is memoized, so this
  // is one connection per server instance rather than one per action.
  getJobs: () => getDb().jobs,
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
