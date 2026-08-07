import { JOB_SCOUT_MAX_LLM_CALLS } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import {
  scoutLlmCallBudget,
  toSearchBrief,
  type JobSearchConfig,
} from "./job-search-config.ts"

function config(overrides: Partial<JobSearchConfig> = {}): JobSearchConfig {
  return {
    titles: ["software engineer"],
    locations: ["Sydney"],
    ...overrides,
  }
}

describe("scoutLlmCallBudget", () => {
  it("never drops below the scout's own floor", () => {
    // One title, one location: the sweep is small enough that the budget is
    // entirely the floor, so adding boards did not change this job at all.
    expect(scoutLlmCallBudget(config(), 3)).toBe(JOB_SCOUT_MAX_LLM_CALLS)
  })

  it("grows with titles, locations and boards together", () => {
    const wide = config({
      titles: ["a", "b", "c"],
      locations: ["Sydney", "Melbourne"],
    })

    // 3 × 2 × 3 searches, plus the turns that are not searches — reading the
    // brief, reading the shortlist back, submitting, and the line it ends on.
    // On one board the same job would have had 10 and been cut off mid-sweep.
    expect(scoutLlmCallBudget(wide, 3)).toBe(24)
    expect(scoutLlmCallBudget(wide, 1)).toBeLessThan(
      scoutLlmCallBudget(wide, 3)
    )
  })

  it("caps, because a bigger budget buys context rather than quality", () => {
    const enormous = config({
      titles: ["a", "b", "c", "d", "e"],
      locations: ["1", "2", "3", "4"],
    })

    expect(scoutLlmCallBudget(enormous, 3)).toBe(40)
  })
})

describe("toSearchBrief", () => {
  const occurrence = new Date("2026-08-05T00:00:00.000Z")

  it("passes sources as context rather than as a restriction", () => {
    // The field looks like a board filter and is not one: every board the
    // scout has a tool for is searched whatever this says. Telling the scout
    // otherwise would have it report a restriction it never applied.
    const brief = toSearchBrief(
      config({ sources: ["seek.com.au"] }),
      occurrence
    )

    expect(brief).toContain("seek.com.au")
    expect(brief).toContain("context, not a restriction")
    expect(brief).not.toMatch(/only|the ones your tools reach/i)
  })

  it("omits the line entirely when the config names no sources", () => {
    expect(toSearchBrief(config(), occurrence)).not.toContain("Job boards")
  })
})
