"use server"

import type { ActionState } from "@/lib/actions/action-state"
import { getCurrentUser } from "@/lib/auth/current-user"
import { getBriefingInvoker } from "@/lib/briefing-runs/invoke-worker"
import { createRunActions } from "@/lib/briefing-runs/run-actions"
import { createCoverLetterActions } from "@/lib/cover-letters/cover-letter-actions"
import { getPrisma } from "@/lib/db"
import { createAddByLinkActions } from "@/lib/postings/add-by-link-actions"
import { createPostingActions } from "@/lib/postings/posting-actions"
import {
  getCoverLetterStore,
  getResumeStore,
  getTailoredResumeStore,
} from "@/lib/storage"
import { createTailoredResumeActions } from "@/lib/tailored-resumes/tailored-resume-actions"
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

const tailoredResumeActions = createTailoredResumeActions({
  getUser: getCurrentUser,
  getPrisma,
  getResumes: getResumeStore,
  getTailoredResumes: getTailoredResumeStore,
})

const postingActions = createPostingActions({
  getUser: getCurrentUser,
  getPrisma,
  getCoverLetters: getCoverLetterStore,
  getTailoredResumes: getTailoredResumeStore,
})

const addByLinkActions = createAddByLinkActions({
  getUser: getCurrentUser,
  getPrisma,
})

/** Create a manually written cover letter from the blank editor. */
export async function createCoverLetterAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.createCoverLetter(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * `refresh()` after a success, for the same reason the document actions call
 * it: `/jobs` is `force-dynamic` and `staleTimes.dynamic` lets the client
 * router reuse the segment for 30 seconds, so without this the page would keep
 * showing a state that predates the draft.
 *
 * The page does render a letter — the Drafted column and the controls in an
 * expanded posting's detail — so this is load-bearing rather than
 * belt-and-braces: without it a first draft leaves the row still offering a
 * first draft.
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
 * stale here is only metadata the expanded detail shows (drafted-on, size).
 * Cheap, and the alternative is the one thing on this page that silently
 * disagrees with storage.
 */
export async function saveCoverLetterAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.saveCoverLetter(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Rewrite the user's CV for one Posting.
 *
 * `refresh()` on success for the reason the draft above gives, and it is
 * load-bearing here in the same way: the expanded detail renders "Generated
 * <date>" plus a download, a PDF button and an editor, and without this a first
 * generation would leave the panel still offering a first one.
 */
export async function generateTailoredResumeAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await tailoredResumeActions.generateTailoredResume(
    state,
    formData
  )

  if (result.status === "success") refresh()

  return result
}

/**
 * Save an edited tailored resume.
 *
 * `refresh()` for the narrower reason `saveCoverLetterAction` gives: the bytes
 * are fetched by the editor rather than rendered by the page, so what goes stale
 * is only the metadata the panel shows. Cheap, and the alternative is a panel
 * that silently disagrees with storage.
 */
export async function saveTailoredResumeAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await tailoredResumeActions.saveTailoredResume(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Add a Posting the user found themselves, from its link.
 *
 * `refresh()` on success is the whole of what puts the new row on the page —
 * `/jobs` is `force-dynamic` and `staleTimes.dynamic` lets the client router
 * reuse the segment for 30 seconds, so without it somebody would paste a link,
 * be told it was added, and look at a table that does not contain it.
 *
 * It is the slowest action in this file by a wide margin: a page fetch and then
 * a model call, in sequence, both on the request. `maxDuration` on `page.tsx`
 * is sized for it.
 */
export async function addPostingByLinkAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await addByLinkActions.addPostingByLink(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Set where one application stands.
 *
 * `refresh()` on success for the reason the draft above gives, with one extra
 * consequence worth naming: `/jobs` is `force-dynamic` and
 * `staleTimes.dynamic` lets the client router reuse the segment for 30 seconds,
 * so a status set in *another* tab can look stale there for that long. This call
 * covers the tab that made the change, which is the one whose user is watching.
 *
 * The select is optimistic, so what this refresh actually settles is everything
 * the new status feeds that the control does not hold itself — the `status`
 * sort order, and any later reader of the row.
 */
export async function setPostingStatusAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await postingActions.setPostingStatus(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * Delete the selected Postings, and the documents each one carries.
 *
 * One export for both the per-row trash icon and the bulk bar — the field
 * repeats, so a row submits a list of one. See `lib/postings/posting-actions.ts`
 * for why the cover letter and the tailored resume are deleted before the row.
 *
 * `refresh()` is the whole of what puts the page back in step here, and unlike
 * the status action there is no optimistic control holding the new state in the
 * meantime: without it the client router would keep serving rows that no longer
 * exist for up to `staleTimes.dynamic`, and clicking one would open a detail
 * for an advertisement the user just removed.
 */
export async function deletePostingsAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await postingActions.deletePostings(state, formData)

  if (result.status === "success") refresh()

  return result
}

/**
 * What an expanded row shows, fetched when the row is expanded.
 *
 * ⚠️ **The one export here that reads rather than writes, and the only one that
 * takes neither `state` nor `FormData`.** That departure from the convention
 * this file otherwise follows is deliberate: `ActionState` exists to carry a
 * message back into the form that submitted it, and there is no form here — the
 * caller is a chevron. It is still a `"use server"` export, so it is still a
 * POST endpoint reachable without the UI, which is why the authorization and
 * the id validation live in `lib/postings/posting-actions.ts` with everything
 * else rather than in the component that calls it.
 *
 * **No `refresh()`**, for the obvious reason: nothing was mutated.
 *
 * It exists because the summary, the match reason and the copied highlights
 * used to ship with all twenty-five rows of every page render for the sake of
 * the one row that might be opened. See `lib/postings/load-posting-detail.ts`.
 */
export async function loadPostingDetailAction(postingId: string) {
  return postingActions.loadPostingDetail(postingId)
}
