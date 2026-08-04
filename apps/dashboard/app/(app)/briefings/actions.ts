"use server"

import type { ActionState } from "@/lib/actions/action-state"
import { getCurrentUser } from "@/lib/auth/current-user"
import { getBriefingInvoker } from "@/lib/briefing-runs/invoke-worker"
import { createRunActions } from "@/lib/briefing-runs/run-actions"
import { createCoverLetterActions } from "@/lib/cover-letters/cover-letter-actions"
import { getPrisma } from "@/lib/db"
import { getCoverLetterStore, getResumeStore } from "@/lib/storage"
import { refresh } from "next/cache"

/**
 * The briefings segment's Server Actions.
 *
 * Follows the convention `app/(app)/documents/actions.ts` sets, point for
 * point: `"use server"` at the top of a dedicated file rather than inline,
 * because every export here is a POST endpoint reachable without going through
 * the UI and the set of them is a security surface; a thin wrapper over a
 * `createXActions(deps)` factory in `lib/`, because the injectable seam is what
 * lets the authorization branches be tested without a live session; and
 * `refresh()` here rather than in the core, because it needs Next's request
 * store.
 *
 * A `"use server"` file may only export async functions, which is why the state
 * type crosses as a type-only import.
 */

const actions = createCoverLetterActions({
  getUser: getCurrentUser,
  getPrisma,
  getResumes: getResumeStore,
  getCoverLetters: getCoverLetterStore,
})

const runActions = createRunActions({
  getUser: getCurrentUser,
  getPrisma,
  getInvoker: getBriefingInvoker,
})

/**
 * `refresh()` after a success, for the same reason the document actions call
 * it: `/briefings` is `force-dynamic` and `staleTimes.dynamic` lets the client
 * router reuse the segment for 30 seconds, so without this the page would keep
 * showing a state that predates the draft.
 *
 * The page does render a letter — the drafted-on line and the download link on
 * each Posting card, and the list above them — so this is load-bearing rather
 * than belt-and-braces: without it a first draft leaves the card still offering
 * a first draft.
 */
export async function draftCoverLetterAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.draftCoverLetter(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Start a briefing now.
 *
 * `refresh()` on success is what puts the new `running` row on the page: the
 * action writes it, and without this the client router would keep serving the
 * segment it cached up to 30 seconds ago and the run would appear not to have
 * started. From there `RefreshWhileRunning` takes over until the run is
 * terminal.
 */
export async function triggerBriefingRunAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await runActions.triggerBriefingRun(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Save an edited letter.
 *
 * `refresh()` for a narrower reason than the draft above: the letter's bytes
 * are fetched by the editor rather than rendered by the page, so what goes
 * stale here is only its `size` in the letters list. Cheap, and the alternative
 * is the one thing on this page that silently disagrees with storage.
 */
export async function saveCoverLetterAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.saveCoverLetter(state, formData)

  if (result.status === "success") refresh()

  return result
}
