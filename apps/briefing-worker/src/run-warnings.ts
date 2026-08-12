import type { Findings, ScoutPosting } from "@workspace/agents"
import type { RunFailure } from "@workspace/db"

import { plural } from "./plural.ts"
import { totalResults, type SearchAttemptLike } from "./search-results.ts"
import type { Tracer } from "./trace.ts"

/**
 * Run an accessory write that must not sink the briefing.
 *
 * After the brief, and never fatal. The rule this does *not* inherit is "a run
 * with no successful search fails": that one guards against silent fabrication
 * — a brief citing postings nobody looked up — and this failure is neither
 * silent nor about the brief. A run that produced a briefing succeeded,
 * whatever happened to the accessory record; the warning it carries is what
 * makes the loss queryable.
 *
 * Returns the error message when the write failed, otherwise `undefined`.
 */
export async function softStep(
  step: "findings" | "postings",
  body: () => Promise<unknown>,
  okDetail: () => string,
  trace: Tracer
): Promise<string | undefined> {
  let notRecorded: string | undefined

  await trace.step(
    step,
    async () => {
      try {
        await body()
      } catch (error) {
        notRecorded = error instanceof Error ? error.message : String(error)
      }
    },
    () =>
      notRecorded === undefined ? okDetail() : `not recorded — ${notRecorded}`
  )

  return notRecorded
}

/**
 * One sentence for the person looking at a briefing that added nothing.
 *
 * Written for them and not for a log: it says which of the two things happened
 * and what they could do about it, because the run itself succeeded and there is
 * nothing else on the page to explain an unchanged table. The counts are in the
 * warning's own fields for anybody who wants them.
 */
export function noPostingsMessage(run: {
  excluded: number
  searches: number
  results: number
  passes: 1 | 2
}): string {
  if (run.excluded > 0) {
    return `Every posting found was ruled out by your excluded titles, so none were added. ${plural(run.excluded, "posting")} matched the criteria and every one of them carried an excluded word.`
  }

  const looked =
    run.passes === 2
      ? `Searched the boards ${plural(run.searches, "time")}, the second pass with the criteria widened`
      : `Searched the boards ${plural(run.searches, "time")}`

  return run.results === 0
    ? `${looked}, and nothing is currently listed for these criteria. Try a broader role title or another location.`
    : `${looked} and looked at ${plural(run.results, "posting")}, none of which matched closely enough to report. Try a broader role title, or fewer required skills.`
}

export interface BuildRunWarningsInput {
  kept: Findings
  excludedPostings: number
  searches: number
  attempts: readonly SearchAttemptLike[]
  scoutPasses: 1 | 2
  widerPassFailed?: string
  findingsNotRecorded?: string
  postingsNotRecorded?: string
  unresolved: readonly ScoutPosting[]
}

/**
 * Assemble the structured warnings a succeeded run may carry.
 *
 * One object holding whichever of the four went wrong, so a run that lost more
 * than one says so once rather than picking a winner. Absent entirely when
 * nothing did, because `finishRun` reads an empty `failure` as a run with
 * warnings.
 */
export function buildRunWarnings(
  input: BuildRunWarningsInput
): RunFailure | undefined {
  const {
    kept,
    excludedPostings,
    searches,
    attempts,
    scoutPasses,
    widerPassFailed,
    findingsNotRecorded,
    postingsNotRecorded,
    unresolved,
  } = input

  /**
   * A run that recorded nothing, said plainly.
   *
   * ⚠️ **The one warning here that is not about something going wrong.** The
   * other three are faults; this is a run that worked and came back empty. It
   * warns anyway, because the alternative is a `succeeded` row, an unchanged
   * table and "last ran 5 minutes ago" as the only thing anybody is told.
   *
   * Two reasons rather than three: a run whose every posting was unresolvable
   * already threw at the hand-off, so that is a failed run, never a quiet one.
   */
  const noPostings =
    kept.postings.length > 0
      ? undefined
      : {
          message: noPostingsMessage({
            excluded: excludedPostings,
            searches,
            results: totalResults(attempts),
            passes: scoutPasses,
          }),
          reason: excludedPostings > 0 ? "all-excluded" : "no-matches",
          searched: searches,
          results: totalResults(attempts),
          excluded: excludedPostings,
          passes: scoutPasses,
          // The scout's own account of the search — a criterion that
          // returned nothing, a board that would not answer. It is the
          // closest thing to an explanation anybody gets, and it is
          // otherwise only in the brief nobody opens when it is empty.
          ...(kept.notes ? { notes: kept.notes } : {}),
          ...(widerPassFailed ? { widerPassFailed } : {}),
        }

  // `unresolvedPostings` is not a lost write like the other two: it is the
  // one thing a person cannot find out any other way. The brief never
  // mentions what was left out of it, and the run succeeded — so without
  // this the only trace of a dropped posting is a trace nobody is
  // watching in production.
  if (
    findingsNotRecorded === undefined &&
    postingsNotRecorded === undefined &&
    noPostings === undefined &&
    unresolved.length === 0
  ) {
    return undefined
  }

  return {
    ...(noPostings === undefined ? {} : { noPostings }),
    ...(findingsNotRecorded === undefined
      ? {}
      : { findings: { message: findingsNotRecorded } }),
    ...(postingsNotRecorded === undefined
      ? {}
      : { postings: { message: postingsNotRecorded } }),
    ...(unresolved.length === 0
      ? {}
      : {
          unresolvedPostings: {
            // Every pass's, not only the one the brief came from: a
            // fabricated id is worth knowing about whether or not
            // the pass that produced it is the pass that was used.
            // Which is why the sentence says "dropped" rather than
            // "left out of the brief" — with two passes the second
            // would name postings that were never candidates for
            // the brief that exists.
            message: `${plural(unresolved.length, "posting")} dropped: the scout named an id no search returned.`,
            // The id and the title, because an id alone identifies
            // nothing to a person reading a warning — and the title
            // is the scout's own, which is the point when what is
            // being diagnosed is a posting it may have invented.
            postings: unresolved.map(({ id, title }) => ({
              id,
              title,
            })),
          },
        }),
  }
}
