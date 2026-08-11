import { JOB_SCOUT_SEARCH_TOOL_NAMES } from "@workspace/agents"

/**
 * What the scout actually looked up, as opposed to what it said.
 *
 * Its own module because the question is one thing and `run-briefing.ts` asks it
 * once: the count in the run report, the "nothing came from a live search" gate,
 * and the warning on a run that recorded nothing all read the answer this gives.
 *
 * ⚠️ **It used to read the transcript, and that was the bug.** A board search
 * that fails comes back to the model as a *sentence* — an actor run that 500s, a
 * timeout, a body that will not parse — and LangChain wraps a returned string as
 * a `status: "success"` ToolMessage, because only a throw sets the error status.
 * So counting non-error tool results counted every failed search as a successful
 * one, and a run whose every actor was down passed the gate that exists to catch
 * exactly that: the scout honestly reported nothing, the brief was written, and
 * the `postings` table went untouched with the run marked `succeeded`.
 *
 * What is read instead is the search log the tools write as they run — see
 * `search-log.ts` in `@workspace/agent-tools`, and
 * {@link JobScoutSession.searches}.
 */

/**
 * Every search tool the scout carries, by name, taken from `@workspace/agents`
 * so that adding a board is one edit over there rather than two edits in two
 * packages, the second of which nothing would catch.
 *
 * Still needed now that the outcomes are recorded rather than inferred: it is
 * what {@link countBySource} seeds its zeroes from, so a board that answered
 * nothing is named in the report rather than merely absent from it.
 */
export const SEARCH_TOOL_NAMES: readonly string[] = JOB_SCOUT_SEARCH_TOOL_NAMES

/**
 * One recorded search, in the terms this worker drives.
 *
 * Structural on purpose, exactly like `PostingLookup` in `resolve-postings.ts`:
 * a real `SearchAttempt` from `@workspace/agent-tools` satisfies it, and so does
 * a hand-rolled fake in a test, without this app taking a dependency on that
 * package for a shape. `query` and `location` are on the real one and left out
 * here — nothing over here reads them.
 */
export interface SearchAttemptLike {
  /** The tool that ran, e.g. `seek_search` — the key the report is filed under. */
  toolName: string
  /** How prose spells the board, for a message a person reads. */
  board: string
  /** `ok` means the board answered, whether or not it had anything to say. */
  outcome: "ok" | "failed"
  /** Postings the search returned. Zero is a legitimate `ok`. */
  results: number
  /** What the model was told instead of results, when the board did not answer. */
  message?: string
}

/**
 * Every search that actually worked, as the name of the board tool it ran on.
 *
 * `ok` is the board having answered, and an empty answer counts: "nobody is
 * advertising this" is a search that happened. What does not count is a board
 * that never answered — see the module note on why that cannot be read off a
 * tool result.
 */
export function successfulSearches(
  attempts: readonly SearchAttemptLike[]
): string[] {
  return attempts
    .filter((attempt) => attempt.outcome === "ok")
    .map((attempt) => attempt.toolName)
}

/** Postings returned across every search that answered. */
export function totalResults(attempts: readonly SearchAttemptLike[]): number {
  return attempts.reduce((total, attempt) => total + attempt.results, 0)
}

/**
 * The failed searches, named by board and quoted once.
 *
 * For the run that dies because *every* search failed, where the whole
 * diagnostic value is in which boards were tried and what they said — a count
 * would send whoever reads the run row to the trace that production does not
 * keep. One message rather than all of them: three actor runs behind the same
 * outage say the same sentence three times.
 */
export function failureSummary(
  attempts: readonly SearchAttemptLike[]
): string | undefined {
  const failed = attempts.filter((attempt) => attempt.outcome === "failed")
  if (failed.length === 0) return undefined

  const boards = [...new Set(failed.map((attempt) => attempt.board))]
  const first = failed.find((attempt) => attempt.message !== undefined)

  return [
    `${failed.length} search(es) failed on ${boards.join(", ")}`,
    ...(first?.message ? [`the first saying: ${first.message}`] : []),
  ].join(", ")
}

/**
 * The results counted per tool, seeded with a zero for every search tool.
 *
 * The zeroes are the point. A board that has quietly stopped answering looks
 * exactly like a board nobody asked about unless its key is present — and a
 * brief assembled from one source reads exactly like a brief assembled from
 * two.
 */
export function countBySource(
  searches: readonly string[],
  toolNames: readonly string[] = SEARCH_TOOL_NAMES
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    toolNames.map((name) => [name, 0])
  )

  for (const tool of searches) counts[tool] = (counts[tool] ?? 0) + 1

  return counts
}
