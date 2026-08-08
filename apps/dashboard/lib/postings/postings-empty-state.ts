/**
 * What to say when the table has no rows, and why there are three answers.
 *
 * This is where the `LatestFindings` union from the deleted
 * `lib/briefings/latest-postings.ts` went. Two of its four states do not
 * survive, and **neither can occur any more** rather than having been folded in
 * somewhere:
 *
 * - **`not-recorded`** — "that run kept no record of what it found" — was about
 *   a Run whose `findings` write failed. Postings are now written by their own
 *   non-fatal step against a payload the worker has already validated, so a
 *   failed findings write is a warning on the run rather than an empty page.
 * - **`unreadable`** — a `findings` record that did not match the schema —
 *   cannot reach this table either, for the same reason: nothing is recorded
 *   until it has parsed.
 *
 * What was `no-run` splits in two, because "you have no briefings" and "your
 * briefings have not run yet" are different situations with different next
 * steps, and the old single message could only address one of them.
 */
export type PostingsEmptyState = "no-briefings" | "no-runs" | "no-postings"

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
 * Which of the three empty states applies. Called only when the total is zero.
 *
 * Pure, and separate from the component, because the branch order is the whole
 * of the logic: a user with no briefings also has no runs and no postings, so
 * the most specific cause has to be tested first or every one of them reads
 * "nothing found yet".
 */
export function postingsEmptyState(
  counts: BriefingCounts | undefined
): PostingsEmptyState {
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
}
