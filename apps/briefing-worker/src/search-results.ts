import { ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { JOB_SCOUT_SEARCH_TOOLS } from "@workspace/agents"

/**
 * Which of a scout's tool results count as searches, and how many came from
 * where.
 *
 * Its own module because the question is one thing and `run-briefing.ts` asks
 * it once: what did the scout actually look up, as opposed to what did it say?
 * Everything downstream — the count in the run report, the "nothing came from a
 * live search" gate, the check that every posting URL was really returned —
 * reads the answer this gives.
 */

/**
 * Every search tool the scout carries, by name, derived from the tools
 * themselves so that adding a board is one edit in `@workspace/agents` rather
 * than two edits in two packages, the second of which nothing would catch.
 */
export const SEARCH_TOOL_NAMES: readonly string[] = JOB_SCOUT_SEARCH_TOOLS.map(
  (tool) => tool.name
)

/** One search that ran and came back, and which tool it came back from. */
export interface SearchResult {
  tool: string
  text: string
}

/**
 * Every search result that actually worked.
 *
 * Two exclusions, and they mean different things. An error result proves
 * nothing ran — the tool was called and did not answer. A result from a tool
 * that is not a search tool is not evidence anyone searched at all, which is
 * why widening this from one name to a set must not widen it to "any tool the
 * scout happens to be holding".
 */
export function successfulSearchResults(
  messages: BaseMessage[],
  toolNames: readonly string[] = SEARCH_TOOL_NAMES
): SearchResult[] {
  // `flatMap` rather than filter-then-map: a type predicate cannot carry the
  // `name !== undefined` narrowing across into the map, and the alternative is
  // asserting a name the filter already proved.
  return messages.flatMap((message) =>
    ToolMessage.isInstance(message) &&
    message.name !== undefined &&
    toolNames.includes(message.name) &&
    message.status !== "error"
      ? [{ tool: message.name, text: message.text }]
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
  results: SearchResult[],
  toolNames: readonly string[] = SEARCH_TOOL_NAMES
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    toolNames.map((name) => [name, 0])
  )

  for (const { tool } of results) counts[tool] = (counts[tool] ?? 0) + 1

  return counts
}
