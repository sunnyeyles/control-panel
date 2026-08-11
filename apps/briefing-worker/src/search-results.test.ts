import { describe, expect, it } from "vitest"

import {
  countBySource,
  failureSummary,
  SEARCH_TOOL_NAMES,
  successfulSearches,
  totalResults,
  type SearchAttemptLike,
} from "./search-results.ts"

/**
 * The rule rather than the wiring, which is `run-briefing.test.ts`'s subject.
 *
 * These used to be assertions about ToolMessages, and the cases they proved were
 * the wrong cases: they showed that a `status: "error"` result was not counted,
 * which was true and irrelevant, because a failed board search never produces
 * one. It returns a sentence and a successful message. What is asserted now is
 * the distinction that actually decides whether a run is believable — the board
 * answered, or it did not.
 */

const BOARDS = ["seek_search", "indeed_search"]

function ok(
  toolName: string,
  results = 1,
  board = toolName === "seek_search" ? "SEEK" : "Indeed"
): SearchAttemptLike {
  return { toolName, board, outcome: "ok", results }
}

function failed(
  toolName: string,
  message = "The search failed with HTTP 500.",
  board = toolName === "seek_search" ? "SEEK" : "Indeed"
): SearchAttemptLike {
  return { toolName, board, outcome: "failed", results: 0, message }
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
  it("keeps every board that answered", () => {
    expect(
      successfulSearches([ok("seek_search"), ok("indeed_search")])
    ).toEqual(["seek_search", "indeed_search"])
  })

  it("counts a board that answered with nothing", () => {
    // The distinction the whole log exists for. Nobody advertising the role is a
    // search that happened, and a run made of these is a quiet market — which
    // must not fail, and must not pass silently either.
    expect(successfulSearches([ok("seek_search", 0)])).toEqual(["seek_search"])
  })

  it("drops a board that did not answer", () => {
    // One board down, the other working: a dead board must not erase a live one,
    // and must not be counted as a live one either. Counting it is what let a
    // run whose every actor failed look like an honest empty result.
    expect(
      successfulSearches([failed("indeed_search"), ok("seek_search")])
    ).toEqual(["seek_search"])
  })

  it("finds nothing successful when every search failed", () => {
    expect(
      successfulSearches([failed("seek_search"), failed("indeed_search")])
    ).toEqual([])
  })
})

describe("totalResults", () => {
  it("adds up what the boards returned", () => {
    expect(totalResults([ok("seek_search", 12), ok("indeed_search", 3)])).toBe(
      15
    )
  })

  it("is zero when every board answered empty", () => {
    expect(totalResults([ok("seek_search", 0), ok("indeed_search", 0)])).toBe(0)
  })
})

describe("failureSummary", () => {
  it("says nothing when nothing failed", () => {
    expect(failureSummary([ok("seek_search")])).toBeUndefined()
  })

  it("names the boards and quotes the first failure", () => {
    const summary = failureSummary([
      failed("seek_search", 'The SEEK search for "a" failed with HTTP 500.'),
      failed("indeed_search", 'The Indeed search for "a" could not be sent.'),
    ])

    expect(summary).toContain("SEEK, Indeed")
    expect(summary).toContain("HTTP 500")
    // One message, not all of them: three actors behind one outage say the same
    // sentence three times.
    expect(summary).not.toContain("could not be sent")
  })

  it("names a board that failed without a message", () => {
    const summary = failureSummary([
      { toolName: "seek_search", board: "SEEK", outcome: "failed", results: 0 },
    ])

    expect(summary).toContain("SEEK")
  })
})

describe("countBySource", () => {
  it("reports a zero for a board that returned nothing", () => {
    // The key has to be present to be read. An absent entry cannot be told
    // apart from a board nobody asked about.
    const counts = countBySource(
      successfulSearches([ok("seek_search")]),
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
