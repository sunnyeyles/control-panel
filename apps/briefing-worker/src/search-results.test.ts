import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import {
  countBySource,
  SEARCH_TOOL_NAMES,
  successfulSearchResults,
} from "./search-results.ts"

/**
 * The multi-source behaviour is tested here rather than through `runBriefing`,
 * because only one board exists today: passing the tool names in is the only
 * way to prove the gate works for two before the second one is written. The
 * run-level tests cover the wiring; these cover the rule.
 */

const BOARDS = ["seek_search", "indeed_search"]

function result(name: string, text = "a posting", id = "call_1"): ToolMessage {
  return new ToolMessage({
    content: text,
    tool_call_id: id,
    name,
    status: "success",
  })
}

function failed(name: string, id = "call_1"): ToolMessage {
  return new ToolMessage({
    content: "search failed",
    tool_call_id: id,
    name,
    status: "error",
  })
}

describe("SEARCH_TOOL_NAMES", () => {
  it("is derived from the tools the scout actually carries", () => {
    // Not a hand-written list: the point of deriving it is that adding a board
    // cannot leave this looking for a name nothing emits.
    expect(SEARCH_TOOL_NAMES).toContain("seek_search")
    expect(SEARCH_TOOL_NAMES.every((name) => name.length > 0)).toBe(true)
  })
})

describe("successfulSearchResults", () => {
  it("counts a result from any of the scout's search tools", () => {
    const results = successfulSearchResults(
      [result("indeed_search", "an Indeed posting")],
      BOARDS
    )

    expect(results).toEqual([
      { tool: "indeed_search", text: "an Indeed posting" },
    ])
  })

  it("keeps results from every source that answered", () => {
    const results = successfulSearchResults(
      [
        result("seek_search", "seek posting", "call_1"),
        result("indeed_search", "indeed posting", "call_2"),
      ],
      BOARDS
    )

    expect(results.map((r) => r.tool)).toEqual(["seek_search", "indeed_search"])
  })

  it("skips a search that errored, and keeps one that did not", () => {
    // One board down, the other working. What survives is what the hand-off
    // checks posting URLs against, so a dead board must not erase a live one.
    const results = successfulSearchResults(
      [
        failed("indeed_search", "call_1"),
        result("seek_search", "ok", "call_2"),
      ],
      BOARDS
    )

    expect(results).toEqual([{ tool: "seek_search", text: "ok" }])
  })

  it("ignores a tool that is not a search tool", () => {
    // A clock answering successfully is not evidence that anyone searched.
    const results = successfulSearchResults(
      [result("get_current_time", "12:00")],
      BOARDS
    )

    expect(results).toEqual([])
  })

  it("ignores messages that are not tool results", () => {
    expect(
      successfulSearchResults([new AIMessage("thinking")], BOARDS)
    ).toEqual([])
  })
})

describe("countBySource", () => {
  it("reports a zero for a board that returned nothing", () => {
    // The key has to be present to be read. An absent entry cannot be told
    // apart from a board nobody asked about.
    const counts = countBySource(
      successfulSearchResults([result("seek_search")], BOARDS),
      BOARDS
    )

    expect(counts).toEqual({ seek_search: 1, indeed_search: 0 })
  })

  it("counts repeated searches on the same board", () => {
    const counts = countBySource(
      [
        { tool: "seek_search", text: "one" },
        { tool: "seek_search", text: "two" },
        { tool: "indeed_search", text: "three" },
      ],
      BOARDS
    )

    expect(counts).toEqual({ seek_search: 2, indeed_search: 1 })
  })

  it("reports every board at zero when nothing searched", () => {
    expect(countBySource([], BOARDS)).toEqual({
      seek_search: 0,
      indeed_search: 0,
    })
  })
})
