/**
 * What to say when the table has no rows, and why there is more than one answer.
 *
 * "You have no briefings" and "your briefings have not run yet" are separate
 * states because they are different situations with different next steps; a
 * single message could only ever address one of them.
 */
export type PostingsEmptyState =
  "no-briefings" | "no-runs" | "no-postings" | "all-filtered"

/**
 * What the strip above the table knows: how many briefings this user has, and
 * how many of them have ever started a Run.
 *
 * `undefined` means the strip's own load failed — a state the page really can
 * be in, since it is a third independent try/catch. Answering "no briefings"
 * then would tell someone with a page full of briefings to go and create one.
 */
export interface BriefingCounts {
  briefings: number
  runs: number
}

/**
 * Which empty state applies. Called only when the total is zero.
 *
 * Pure, and separate from the component, because the branch order is the whole of
 * the logic: a user with no briefings also has no runs and no postings, so the
 * most specific cause has to be tested first or every one reads "nothing found
 * yet".
 */
export function postingsEmptyState(
  counts: BriefingCounts | undefined,
  hidden = 0
): PostingsEmptyState {
  // ⚠️ **First, ahead of every other cause.** A user whose filters removed every
  // row has postings, so "your briefings found nothing, widen your criteria"
  // would send them to fix a search that is working. It is also the only state
  // with an undo, which is the thing worth saying.
  if (hidden > 0) return "all-filtered"

  if (counts === undefined) return "no-postings"
  if (counts.briefings === 0) return "no-briefings"
  if (counts.runs === 0) return "no-runs"

  return "no-postings"
}

/**
 * Each state says what happened and what to do next — the second half is the
 * point. "No postings" on its own leaves a user with nothing to try.
 */
export const POSTINGS_EMPTY_MESSAGES: Record<PostingsEmptyState, string> = {
  "no-briefings":
    "No briefings yet. Create one in Schedules and the postings it finds will appear here.",
  "no-runs":
    "None of your briefings has run yet. Use Run now above, or wait for the next scheduled run.",
  "no-postings":
    "No postings yet. Your briefings have run and found nothing matching their search criteria — you can widen those in Schedules.",
  "all-filtered":
    "Every posting you have is hidden by your title filters. Edit or clear them in Schedules to see them again — nothing has been deleted.",
}
