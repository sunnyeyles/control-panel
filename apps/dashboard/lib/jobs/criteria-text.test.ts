import { JOB_SCOUT_SEARCH_TOOL_NAMES } from "@workspace/agents"
import { scoutLlmCallBudget } from "@workspace/job-search"
import { describe, expect, it } from "vitest"

import {
  appendRoleTitle,
  fitsSearchBudget,
  hasRoleTitle,
  MAX_ROLE_TITLES,
  MAX_SEARCHES_PER_RUN,
  SEARCH_BOARD_COUNT,
  searchesPerRun,
  splitCriteria,
} from "./criteria-text"

describe("splitCriteria", () => {
  it("trims and drops blanks", () => {
    expect(splitCriteria(" Software Engineer , Data Engineer ")).toEqual([
      "Software Engineer",
      "Data Engineer",
    ])
  })

  it("reads every shape of nothing as an empty list", () => {
    expect(splitCriteria("")).toEqual([])
    expect(splitCriteria("   ")).toEqual([])
    expect(splitCriteria(",,")).toEqual([])
  })
})

describe("searchesPerRun", () => {
  it("is titles by locations by boards", () => {
    expect(searchesPerRun(3, 2)).toBe(3 * 2 * SEARCH_BOARD_COUNT)
  })
})

describe("fitsSearchBudget", () => {
  it("passes the widest combination the form allows", () => {
    expect(fitsSearchBudget(MAX_ROLE_TITLES, 3)).toBe(true)
  })

  it("refuses a fourth location at the title cap", () => {
    expect(fitsSearchBudget(MAX_ROLE_TITLES, 4)).toBe(false)
  })
})

/**
 * ⚠️ **The drift alarms.**
 *
 * `criteria-text.ts` may import nothing, so both numbers in it are hand-kept
 * copies of facts owned elsewhere. This suite is what stops them from being
 * merely *stated*. It runs in node, where the real modules are reachable —
 * which is the whole reason the dashboard's logic lives under `lib/` and
 * imports no Next.
 *
 * The failure being guarded against is the quiet one: a fourth board, or a
 * lower ceiling in the worker, would leave the form promising a sweep the scout
 * is cut off partway through. That produces a well-formed brief covering less
 * than it was asked to, and nothing downstream can tell it from a quiet market.
 */
describe("the form's copies of the worker's numbers", () => {
  it("counts the boards the scout actually carries", () => {
    expect(SEARCH_BOARD_COUNT).toBe(JOB_SCOUT_SEARCH_TOOL_NAMES.length)
  })

  /**
   * Behavioural rather than arithmetic, because `MAX_SCOUT_LLM_CALLS` and
   * `NON_SEARCH_TURNS` are private to `job-search-config.ts` and should stay
   * that way. A budget that has been clamped is one at or below the sweep it
   * was sized for; an unclamped one always exceeds it, because the non-search
   * turns are added on top.
   */
  it("never permits a combination the scout would be cut off mid-sweep", () => {
    for (let titles = 1; titles <= MAX_ROLE_TITLES; titles += 1) {
      for (let locations = 1; locations <= 20; locations += 1) {
        if (!fitsSearchBudget(titles, locations)) continue

        const config = {
          titles: Array.from({ length: titles }, (_, index) => `t${index}`),
          locations: Array.from(
            { length: locations },
            (_, index) => `l${index}`
          ),
        }

        expect(
          scoutLlmCallBudget(config, SEARCH_BOARD_COUNT),
          `${titles} titles × ${locations} locations`
        ).toBeGreaterThan(searchesPerRun(titles, locations))
      }
    }
  })

  /**
   * The other direction: the ceiling has to be the *real* one, not merely a
   * safe one. A `MAX_SEARCHES_PER_RUN` set needlessly low would refuse
   * combinations that work, and nothing else in the suite would notice.
   */
  it("is not stricter than the scout requires", () => {
    const overBudget = {
      titles: ["a", "b"],
      locations: Array.from({ length: 20 }, (_, index) => `l${index}`),
    }
    const searches = searchesPerRun(2, 20)

    expect(searches).toBeGreaterThan(MAX_SEARCHES_PER_RUN)
    expect(
      scoutLlmCallBudget(overBudget, SEARCH_BOARD_COUNT)
    ).toBeLessThanOrEqual(searches)
  })
})

describe("appendRoleTitle", () => {
  it("appends to an empty field", () => {
    expect(appendRoleTitle("", "Software Engineer")).toBe("Software Engineer")
  })

  it("appends with the separator the field is parsed by", () => {
    expect(appendRoleTitle("Software Engineer", "Data Engineer")).toBe(
      "Software Engineer, Data Engineer"
    )
  })

  it("normalises the spacing of what was already there", () => {
    expect(appendRoleTitle("Software Engineer ,,  ", "Data Engineer")).toBe(
      "Software Engineer, Data Engineer"
    )
  })

  /**
   * Two agents propose these buttons independently and will sometimes agree.
   * Without this, one click on each spends two Apify runs on one role.
   */
  it("refuses a title already present, however it is spelled", () => {
    expect(appendRoleTitle("Software Engineer", "software engineer")).toBe(
      "Software Engineer"
    )
    expect(
      appendRoleTitle("Full Stack Developer", "Full-Stack Developer")
    ).toBe("Full Stack Developer")
  })

  it("is a no-op at the cap", () => {
    const full = "One, Two, Three"

    expect(appendRoleTitle(full, "Four")).toBe(full)
  })

  it("is a no-op for a blank title", () => {
    expect(appendRoleTitle("Software Engineer", "   ")).toBe(
      "Software Engineer"
    )
  })
})

/**
 * The button's disabled check and the append's refusal must agree, or a
 * differently-cased duplicate is a live button that does nothing.
 */
describe("hasRoleTitle", () => {
  it("matches regardless of case and punctuation", () => {
    expect(hasRoleTitle("Software Engineer", "software engineer")).toBe(true)
    expect(hasRoleTitle("Full Stack Developer", "Full-Stack Developer")).toBe(
      true
    )
  })

  it("is false for a title the field does not hold", () => {
    expect(hasRoleTitle("Software Engineer", "Data Engineer")).toBe(false)
    expect(hasRoleTitle("", "Data Engineer")).toBe(false)
  })

  it("agrees with appendRoleTitle on every case", () => {
    const cases: [string, string][] = [
      ["Software Engineer", "software engineer"],
      ["Software Engineer", "Data Engineer"],
      ["Full Stack Developer", "Full-Stack Developer"],
      ["", "Data Engineer"],
      ["One, Two", "one"],
    ]

    for (const [value, title] of cases) {
      const refused = appendRoleTitle(value, title) === value

      expect(hasRoleTitle(value, title), `${value} + ${title}`).toBe(refused)
    }
  })
})
