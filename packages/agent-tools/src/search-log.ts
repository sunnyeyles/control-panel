/**
 * Every search a run attempted, and whether it worked.
 *
 * The transcript cannot answer that question, which is why this exists. A board
 * search that fails — an actor run that 500s, a timeout, a body that will not
 * parse — comes back to the model as a *sentence* rather than a throw, on purpose
 * (`apify-search.ts` explains why one bad search must not sink a run). Only a
 * throw sets `status: "error"` on the resulting ToolMessage, so from the outside
 * "the SEEK search failed with HTTP 500" and "here are 12 SEEK postings" are the
 * same kind of message. A caller counting successful searches off the transcript
 * counted both, and a run whose every actor failed looked like a run that had
 * honestly found nothing.
 *
 * So the outcome is recorded where it is known — inside the search — rather than
 * inferred afterwards from what the model was told.
 *
 * One log per run, created by whoever builds the tools, exactly like the
 * {@link PostingCatalog} beside it: a module-level instance would carry one run's
 * attempts into the next, and on a warm Lambda container that is not
 * hypothetical.
 */

/** One call of one board's search tool. */
export interface SearchAttempt {
  /**
   * The tool the model called, e.g. `seek_search`.
   *
   * The tool name rather than the board, because this is the key a caller
   * reports the counts under and a tool name is what the scout's own
   * `JOB_SCOUT_SEARCH_TOOL_NAMES` enumerates. {@link SearchAttempt.board} is
   * the same fact spelled for a person.
   */
  toolName: string
  /** How prose spells the board: `SEEK`, `Indeed`, `LinkedIn`. */
  board: string
  /** What was searched for, as the model asked for it. */
  query: string
  /** Where, when the model said — the board's own spelling. */
  location?: string
  /**
   * Whether the board answered.
   *
   * `"ok"` means the actor ran and returned a result list, whether or not
   * anything was in it. `"failed"` means it did not answer at all. Keeping a
   * genuinely empty search on the `"ok"` side is the whole point of recording
   * this: "nobody is advertising that role" and "the scraper is down" produce
   * the same empty brief and want opposite responses.
   */
  outcome: "ok" | "failed"
  /** Postings catalogued and rendered to the model. Zero on a failure. */
  results: number
  /** The sentence the model was given instead of results, when it failed. */
  message?: string
}

export interface SearchLog {
  record(attempt: SearchAttempt): void
  /** Every attempt this run made, in the order they completed. */
  attempts(): readonly SearchAttempt[]
}

export function createSearchLog(): SearchLog {
  const attempts: SearchAttempt[] = []

  return {
    record(attempt) {
      attempts.push(attempt)
    },

    attempts() {
      return attempts
    },
  }
}
