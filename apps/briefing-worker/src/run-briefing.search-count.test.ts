import { describe, expect, it, vi } from "vitest"

import {
  SCOUT_FINDINGS,
  installRunBriefingFixtures,
  noSearches,
  run,
  scoutReturning,
  searchFailed,
  searched,
} from "./run-briefing.test-helpers.ts"

installRunBriefingFixtures()

/**
 * The wiring only. That the rule itself holds — an empty answer counting, a
 * failed board not counting — is `search-results.test.ts`'s subject, where the
 * attempts can be handed in directly.
 */
describe("the search count reaching the run report", () => {
  it("counts each board that answered, under its own name", async () => {
    const report = await run({
      createScout: scoutReturning(SCOUT_FINDINGS, [
        searched("seek_search"),
        searched("seek_search"),
        searched("indeed_search", 1, "Indeed"),
      ]),
    })

    expect(report.searches).toBe(3)
    expect(report.searchesBySource).toEqual({
      ...noSearches(),
      seek_search: 2,
      indeed_search: 1,
    })
  })

  it("counts a board that answered with nothing", async () => {
    // The distinction the search log exists for: nobody advertising the role
    // is a search that happened, and this run is a quiet market rather than a
    // broken pipeline.
    const report = await run({
      createScout: scoutReturning(SCOUT_FINDINGS, [searched("seek_search", 0)]),
    })

    expect(report.searches).toBe(1)
  })

  it("survives a search that failed alongside one that worked", async () => {
    // Narrower coverage, not a failed run. A board that went quiet belongs
    // in the findings' notes; it is not grounds for throwing away a brief
    // built from postings that were genuinely looked up.
    const report = await run({
      createScout: scoutReturning(SCOUT_FINDINGS, [
        searchFailed("indeed_search", "Indeed"),
        searched("seek_search"),
      ]),
    })

    expect(report.outcome).toBe("success")
    expect(report.searches).toBe(1)
  })

  it("carries the per-board breakdown onto a failure report", async () => {
    // A run that searched nothing still has to say so per board — that is
    // what makes "which board went quiet, and when" a log query.
    const log = vi.mocked(console.log)

    await expect(
      run({
        createScout: scoutReturning(SCOUT_FINDINGS, [searchFailed()]),
      })
    ).rejects.toThrow()

    const failure = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(failure.searchesBySource).toEqual(noSearches())
  })
})
