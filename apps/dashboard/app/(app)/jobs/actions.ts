"use server"

import type { ActionState } from "@/lib/actions/action-state"
import { getCurrentUser } from "@/lib/auth/current-user"
import { getBriefingInvoker } from "@/lib/briefing-runs/invoke-worker"
import { createRunActions } from "@/lib/briefing-runs/run-actions"
import { createCoverLetterActions } from "@/lib/cover-letters/cover-letter-actions"
import { getPrisma } from "@/lib/db"
import { createAddByLinkActions } from "@/lib/postings/add-by-link-actions"
import { createMatchActions } from "@/lib/postings/match-actions"
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
 * Follows the convention `app/(app)/documents/actions.ts` sets: a dedicated
 * `"use server"` file, because every export is a POST endpoint reachable
 * without the UI and the set of them is a security surface; a thin wrapper over
 * a `createXActions(deps)` factory in `lib/`, because that seam is what lets
 * the authorization branches be tested without a live session; and `refresh()`
 * here rather than in the core, because it needs Next's request store.
 *
 * ⚠️ A `"use server"` file may only export async functions, which is why the
 * state type crosses as a type-only import.
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

const matchActions = createMatchActions({
  getUser: getCurrentUser,
  getPrisma,
  getResumes: getResumeStore,
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
 * ⚠️ `refresh()` is load-bearing, not belt-and-braces: `/jobs` is
 * `force-dynamic` and `staleTimes.dynamic` lets the client router reuse the
 * segment for 30 seconds, so without it a first draft leaves the Drafted column
 * still offering a first draft.
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
 * `refresh()` is what puts the new `running` row on the page — without it the
 * cached segment makes the run appear not to have started. `RefreshWhileRunning`
 * takes over from there until the run is terminal.
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
 * `refresh()` for a narrower reason than the draft above: the bytes are fetched
 * by the editor, so what goes stale is only the metadata the expanded detail
 * shows (drafted-on, size).
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
 * `refresh()` is load-bearing as it is for the draft above: the expanded detail
 * renders "Generated <date>" plus a download, a PDF button and an editor, so
 * without it a first generation leaves the panel offering a first one.
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
 * `refresh()` for the narrower reason `saveCoverLetterAction` gives: only the
 * metadata the panel shows goes stale.
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
 * `refresh()` is the whole of what puts the new row on the page — without it
 * somebody pastes a link, is told it was added, and looks at a table that does
 * not contain it.
 *
 * ⚠️ The slowest action in this file by a wide margin: a page fetch then a
 * model call, in sequence, both on the request. `maxDuration` on `page.tsx` is
 * sized for it.
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
 * ⚠️ `refresh()` covers the tab that made the change only — a status set in
 * *another* tab can look stale there for `staleTimes.dynamic`.
 *
 * The select is optimistic, so what this settles is what the control does not
 * hold itself: the `status` sort order, and any later reader of the row.
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
 * ⚠️ `refresh()` is the whole of what puts the page back in step — unlike the
 * status action there is no optimistic control meanwhile, so without it the
 * router serves deleted rows for up to `staleTimes.dynamic` and clicking one
 * opens a detail for an advertisement the user just removed.
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
 * Score a batch of this user's unscored Postings against their resume.
 *
 * ⚠️ **Takes neither `state` nor `FormData`, like `loadPostingDetailAction`**:
 * `ActionState` carries a message back into a form, and there is no form — the
 * caller is a component that mounted. Still a POST endpoint reachable without
 * the UI, which is why every authorization branch is in `match-actions.ts`.
 *
 * ⚠️ **`refresh()` only when something was written**, unlike every other action
 * here. The component loops until a round writes nothing, and the last round of
 * every run is that round — so an unconditional refresh would re-render `/jobs`
 * for no change on every page view. On the rounds that do write it is
 * load-bearing: the Match column is server-rendered.
 */
export async function scorePendingMatchesAction() {
  const result = await matchActions.scorePendingMatches()

  if (result.status === "success" && result.scored > 0) refresh()

  return result
}

/**
 * What an expanded row shows, fetched when the row is expanded.
 *
 * ⚠️ **The one export here that reads rather than writes.** No `state` or
 * `FormData` — the caller is a chevron, not a form — and no `refresh()`, since
 * nothing was mutated. Still a POST endpoint reachable without the UI, so
 * authorization and id validation live in `lib/postings/posting-actions.ts`.
 *
 * It exists because the summary, match reason and highlights used to ship with
 * all twenty-five rows for the sake of the one that might be opened.
 */
export async function loadPostingDetailAction(postingId: string) {
  return postingActions.loadPostingDetail(postingId)
}
