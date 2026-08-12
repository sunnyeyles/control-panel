"use server"

import type { ActionState } from "@/lib/actions/action-state"
import { getCurrentUser } from "@/lib/auth/current-user"
import { createLetterInstructionsActions } from "@/lib/cover-letters/letter-instructions-actions"
import { getPrisma } from "@/lib/db"
import { getResumeStore } from "@/lib/storage"
import { refresh } from "next/cache"

/**
 * The cover-letter settings actions, following the convention
 * `app/(app)/documents/actions.ts` sets — see its docblock for the six rules.
 * In short: `"use server"` at the top of a dedicated file so the set of POST
 * endpoints is auditable in one place, a thin wrapper over a
 * `createXActions(deps)` factory in `lib/` that imports no Next, and cache
 * invalidation here rather than in the core because `refresh()` needs a request
 * store.
 *
 * **One file per segment, and the siblings stay separate.** Merging these back
 * together with `jobs/schedules/actions.ts` because they are one section again
 * would undo the point: the exported action set of a segment is a security
 * surface, auditable when it is the four things one page can do, not fifteen.
 */

/**
 * The cover-letter settings.
 *
 * `getResumeStore` is for the import path alone, and is resolved per call
 * inside the action bodies for the reason `getPrisma` is: this factory runs at
 * module scope, where constructing an `S3Client` would read configuration at
 * import time.
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
