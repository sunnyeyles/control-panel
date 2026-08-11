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
    // One title, one location, one board: the sweep is small enough that the
    // computed budget is under the floor, and the floor is what a job gets.
    expect(scoutLlmCallBudget(config(), 1)).toBe(JOB_SCOUT_MAX_LLM_CALLS)
  })

  it("grows with titles, locations and boards together", () => {
    const wide = config({
      titles: ["a", "b", "c"],
      locations: ["Sydney", "Melbourne"],
    })

    // 3 × 2 × 3 searches, plus the turns that are not searches — reading the
    // brief, reading the shortlist back (which is two calls now that a brief
    // asks for twenty postings), submitting, and the line it ends on. On one
    // board the same job would have had 14 and been cut off mid-sweep.
    expect(scoutLlmCallBudget(wide, 3)).toBe(26)
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

  /**
   * The line that was the real cap on every briefing in production. Nothing has
   * ever written `maxPostings` into a config, so whatever the default says is
   * what every run asks for.
   */
  describe("how many postings to ask for", () => {
    it("asks for twenty when the config does not say", () => {
      expect(toSearchBrief(config(), occurrence)).toContain(
        "Return at most 20 postings"
      )
    })

    it("asks for what the briefing set, when it set one", () => {
      expect(toSearchBrief(config({ maxPostings: 5 }), occurrence)).toContain(
        "Return at most 5 postings"
      )
    })
  })

  /**
   * The wider pass, which a run gets when the first one reported nothing.
   *
   * What matters is that it is the *same criteria*, read as preferences: a brief
   * that widened the role title into a different job would come back with
   * postings and answer a question nobody asked.
   */
  describe("the wider pass", () => {
    const wider = (overrides: Partial<JobSearchConfig> = {}) =>
      toSearchBrief(config(overrides), occurrence, [], "wider")

    it("says a first pass found nothing, and says how to widen", () => {
      const brief = wider()

      expect(brief).toContain("A first pass over exactly these criteria")
      expect(brief).toMatch(/search wider/i)
      expect(brief).toMatch(/preferences rather than requirements/i)
    })

    it("keeps the criteria themselves", () => {
      const brief = wider({ keywords: ["typescript"] })

      expect(brief).toContain("software engineer")
      expect(brief).toContain("Sydney")
      expect(brief).toContain("typescript")
    })

    it("leaves the title exclusions exactly as they were", () => {
      // They are enforced after the scout reports either way, so relaxing them
      // here would only buy postings that are about to be thrown away.
      const brief = toSearchBrief(config(), occurrence, ["principal"], "wider")

      expect(brief).toContain(
        "Never report a posting whose title contains any of these words: principal"
      )
    })

    it("is not in a first-pass brief at all", () => {
      // A run that has not failed at anything must read exactly as it did before
      // the second pass existed.
      expect(toSearchBrief(config(), occurrence)).not.toMatch(/search wider/i)
    })
  })
})
