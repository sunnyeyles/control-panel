"use server"

import { getCurrentUser } from "@/lib/auth/current-user"
import { getPrisma } from "@/lib/db"
import type { ActionState } from "@/lib/actions/action-state"
import { createLetterInstructionsActions } from "@/lib/cover-letters/letter-instructions-actions"
import { createJobActions } from "@/lib/jobs/job-actions"
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
 * `refresh()` after every success is not optional here. `next.config.ts` sets
 * `staleTimes.dynamic: 30`, so without it a switch the user just turned off
 * comes back on when they navigate away and back — the cached segment outliving
 * the change that made it stale. `documents/actions.ts` explains why it is
 * `refresh()` rather than `revalidatePath` or `revalidateTag`.
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
 * The cover-letter settings, over the same seam and on the same page.
 *
 * `getResumeStore` is here for the import path alone — it reads the document
 * being copied from — and is resolved per call inside the action bodies for the
 * reason `getPrisma` is: this factory runs at module scope, and constructing an
 * `S3Client` there would read configuration at import time.
 */
const letterInstructions = createLetterInstructionsActions({
  getUser: getCurrentUser,
  getPrisma,
  getResumes: getResumeStore,
})

export async function saveLetterInstructionsAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await letterInstructions.saveLetterInstructions(
    state,
    formData
  )

  // Mandatory here rather than merely tidy: the section renders the saved text
  // as a `defaultValue`, so without this `staleTimes.dynamic: 30` serves the
  // pre-save text back the next time the user visits the page — and it looks
  // exactly like a save that silently did not happen.
  if (result.status === "success") refresh()

  return result
}

export async function importExampleLetterAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await letterInstructions.importExampleLetter(state, formData)

  // Same reason, and more visibly: an import whose text does not appear in the
  // box it just filled reads as an import that failed.
  if (result.status === "success") refresh()

  return result
}
