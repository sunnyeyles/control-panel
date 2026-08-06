import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import {
  countBySource,
  SEARCH_TOOL_NAMES,
  successfulSearches,
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
  it("names the boards the scout actually carries", () => {
    // Taken from `@workspace/agents` rather than written out here: the point is
    // that adding a board cannot leave this looking for a name nothing emits.
    expect(SEARCH_TOOL_NAMES).toContain("seek_search")
    expect(SEARCH_TOOL_NAMES.every((name) => name.length > 0)).toBe(true)
  })

  it("does not count reading a posting back as searching for one", () => {
    // `get_posting_details` answers out of the catalog and reaches no board, so
    // a run that only ever read would otherwise look like a run that searched.
    expect(SEARCH_TOOL_NAMES).not.toContain("get_posting_details")
    expect(SEARCH_TOOL_NAMES).not.toContain("submit_findings")
  })
})

describe("successfulSearches", () => {
  it("counts a result from any of the scout's search tools", () => {
    const searches = successfulSearches(
      [result("indeed_search", "an Indeed posting")],
      BOARDS
    )

    expect(searches).toEqual(["indeed_search"])
  })

  it("keeps results from every source that answered", () => {
    const searches = successfulSearches(
      [
        result("seek_search", "seek posting", "call_1"),
        result("indeed_search", "indeed posting", "call_2"),
      ],
      BOARDS
    )

    expect(searches).toEqual(["seek_search", "indeed_search"])
  })

  it("skips a search that errored, and keeps one that did not", () => {
    // One board down, the other working. This is what the run's "something
    // actually searched" gate reads, so a dead board must not erase a live one.
    const searches = successfulSearches(
      [
        failed("indeed_search", "call_1"),
        result("seek_search", "ok", "call_2"),
      ],
      BOARDS
    )

    expect(searches).toEqual(["seek_search"])
  })

  it("ignores a tool that is not a search tool", () => {
    // A clock answering successfully is not evidence that anyone searched.
    const searches = successfulSearches(
      [result("get_current_time", "12:00")],
      BOARDS
    )

    expect(searches).toEqual([])
  })

  it("ignores messages that are not tool results", () => {
    expect(successfulSearches([new AIMessage("thinking")], BOARDS)).toEqual([])
  })
})

describe("countBySource", () => {
  it("reports a zero for a board that returned nothing", () => {
    // The key has to be present to be read. An absent entry cannot be told
    // apart from a board nobody asked about.
    const counts = countBySource(
      successfulSearches([result("seek_search")], BOARDS),
      BOARDS
    )

    expect(counts).toEqual({ seek_search: 1, indeed_search: 0 })
  })

  it("counts repeated searches on the same board", () => {
    const counts = countBySource(
      ["seek_search", "seek_search", "indeed_search"],
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
