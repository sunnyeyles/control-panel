import { ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { JOB_SCOUT_SEARCH_TOOL_NAMES } from "@workspace/agents"

/**
 * Which of a scout's tool results count as searches, and how many came from
 * where.
 *
 * Its own module because the question is one thing and `run-briefing.ts` asks
 * it once: what did the scout actually look up, as opposed to what did it say?
 * The count in the run report and the "nothing came from a live search" gate
 * both read the answer this gives.
 */

/**
 * Every search tool the scout carries, by name, taken from `@workspace/agents`
 * so that adding a board is one edit over there rather than two edits in two
 * packages, the second of which nothing would catch.
 */
export const SEARCH_TOOL_NAMES: readonly string[] = JOB_SCOUT_SEARCH_TOOL_NAMES

/**
 * Every search that actually worked, as the name of the board tool it ran on.
 *
 * The name is the whole answer now. It used to carry the rendered result text
 * beside it, because the URL check re-extracted every URL a search had returned
 * from that text; the run's posting catalog holds those directly, so what is
 * left of this question is how many searches ran and on which boards.
 *
 * Two exclusions, and they mean different things. An error result proves
 * nothing ran — the tool was called and did not answer. A result from a tool
 * that is not a search tool is not evidence anyone searched at all, which is
 * why widening this from one name to a set must not widen it to "any tool the
 * scout happens to be holding": `get_posting_details` answers out of the
 * catalog and would otherwise count as a search that never happened.
 */
export function successfulSearches(
  messages: BaseMessage[],
  toolNames: readonly string[] = SEARCH_TOOL_NAMES
): string[] {
  // `flatMap` rather than filter-then-map: a type predicate cannot carry the
  // `name !== undefined` narrowing across into the map, and the alternative is
  // asserting a name the filter already proved.
  return messages.flatMap((message) =>
    ToolMessage.isInstance(message) &&
    message.name !== undefined &&
    toolNames.includes(message.name) &&
    message.status !== "error"
      ? [message.name]
      : []
  )
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
