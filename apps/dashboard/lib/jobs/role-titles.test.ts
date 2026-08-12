import { describe, expect, it } from "vitest"

import {
  canonicalRoleTitle,
  matchRoleTitles,
  ROLE_TITLES,
  roleTitleCompletions,
} from "./role-titles"

describe("ROLE_TITLES", () => {
  it("holds no duplicates", () => {
    expect(new Set(ROLE_TITLES).size).toBe(ROLE_TITLES.length)
  })

  it("is sorted, which is what makes the alphabetical tiebreak free", () => {
    const sorted = [...ROLE_TITLES].sort((left, right) =>
      left.localeCompare(right)
    )

    expect(ROLE_TITLES).toEqual(sorted)
  })

  /**
   * Not a target to hit — a bound to notice crossing. The whole list ships to
   * the browser, so a tenfold growth is a bundle decision rather than an
   * ordinary edit, and it should be made deliberately.
   */
  it("stays small enough to ship to the client", () => {
    const bytes = ROLE_TITLES.join(",").length

    expect(ROLE_TITLES.length).toBeGreaterThan(400)
    expect(bytes).toBeLessThan(40_000)
  })

  it("expands the seniority ladder onto the titles that carry one", () => {
    expect(ROLE_TITLES).toContain("Software Engineer")
    expect(ROLE_TITLES).toContain("Senior Software Engineer")
    expect(ROLE_TITLES).toContain("Principal Software Engineer")
  })

  /**
   * The ladder is applied to a chosen subset rather than to everything, and
   * this is the assertion that keeps somebody from "simplifying" that away.
   */
  it("does not put a seniority in front of a title that cannot carry one", () => {
    expect(ROLE_TITLES).toContain("Chief Technology Officer")
    expect(ROLE_TITLES).not.toContain("Senior Chief Technology Officer")
    expect(ROLE_TITLES).not.toContain("Graduate Head of Engineering")
  })
})

describe("matchRoleTitles", () => {
  /** The case from the feature request, and the one everything else serves. */
  it("completes a half-typed word", () => {
    const matches = matchRoleTitles("Software en")

    expect(matches).toContain("Software Engineer")
    expect(matches[0]).toBe("Software Engineer")
  })

  it("ignores case and punctuation on both sides", () => {
    expect(matchRoleTitles("SOFTWARE EN")).toContain("Software Engineer")
    expect(matchRoleTitles("full-stack dev")).toContain("Full Stack Developer")
    expect(matchRoleTitles("node.js")).toContain("Node.js Developer")
  })

  /**
   * Word-wise rather than whole-string, because the specialism is what a
   * person is least sure how to spell out and most likely to reach for first.
   */
  it("matches a word anywhere in the title, not only the first", () => {
    expect(matchRoleTitles("engineer")).toContain("Data Engineer")
  })

  /**
   * The ordering rule, stated as behaviour: a title the fragment opened is a
   * better answer than one it landed in the middle of.
   */
  it("ranks a first-word match above a later one", () => {
    const matches = matchRoleTitles("data")
    const engineer = matches.indexOf("Data Engineer")
    const chief = matches.indexOf("Chief Data Officer")

    expect(engineer).toBeGreaterThanOrEqual(0)
    if (chief >= 0) expect(engineer).toBeLessThan(chief)
  })

  it("ranks a shorter title above a longer one that matched as early", () => {
    const matches = matchRoleTitles("data eng")

    expect(matches.indexOf("Data Engineer")).toBeLessThan(
      matches.indexOf("Data Platform Engineer")
    )
  })

  /**
   * Order matters, and this is the assertion that says so. A rule matching
   * regardless of order would answer "en software" with "Software Engineer",
   * which is a completion for a fragment the user was steering elsewhere.
   */
  it("requires the fragment's words in the title's order", () => {
    expect(matchRoleTitles("software en")).toContain("Software Engineer")
    expect(matchRoleTitles("en software")).not.toContain("Software Engineer")
  })

  it("offers nothing below the fragment floor", () => {
    expect(matchRoleTitles("s")).toEqual([])
    expect(matchRoleTitles(" ")).toEqual([])
    expect(matchRoleTitles("")).toEqual([])
  })

  it("offers nothing for a fragment that is only punctuation", () => {
    expect(matchRoleTitles("---")).toEqual([])
    expect(matchRoleTitles(", ,")).toEqual([])
  })

  it("honours the limit", () => {
    expect(matchRoleTitles("e", 3)).toEqual([])
    expect(matchRoleTitles("engineer", 3)).toHaveLength(3)
    expect(matchRoleTitles("engineer").length).toBeLessThanOrEqual(8)
  })

  it("returns nothing for a title no family covers", () => {
    expect(matchRoleTitles("zzzz")).toEqual([])
  })

  /**
   * The deterministic half of this feature is only worth having if it is
   * actually deterministic — the AI suggestions beside it are allowed to vary,
   * and this one is not.
   */
  it("answers identically every time", () => {
    expect(matchRoleTitles("eng")).toEqual(matchRoleTitles("eng"))
    expect(matchRoleTitles("senior back")).toEqual(
      matchRoleTitles("senior back")
    )
  })

  it("completes a laddered title from its seniority", () => {
    expect(matchRoleTitles("senior back")).toContain("Senior Backend Engineer")
  })

  /**
   * ⚠️ **Shortest-first is doing real work on an ambiguous fragment, and the
   * answer is not the most common role.** `sof` puts "Software Tester" above
   * "Software Engineer" purely because it is two characters shorter — the rule
   * behaving as specified, asserted so that changing it is a decision.
   *
   * Ranking by how often a title appears on a board is deliberately not done:
   * there is no frequency data in this repo, a hand-assigned weight per title is
   * a tuning knob eight hundred entries wide, and the property this list is
   * *for* is that the same fragment always gives the same answer.
   */
  it("breaks a tie on length, not on how common the role is", () => {
    const matches = matchRoleTitles("sof")

    expect(matches[0]).toBe("Software Tester")
    expect(matches).toContain("Software Engineer")
    expect(matchRoleTitles("softwar en")[0]).toBe("Software Engineer")
  })
})

describe("canonicalRoleTitle", () => {
  it("returns the list's spelling for a title that differs only in form", () => {
    expect(canonicalRoleTitle("full-stack developer")).toBe(
      "Full Stack Developer"
    )
    expect(canonicalRoleTitle("SITE RELIABILITY ENGINEER")).toBe(
      "Site Reliability Engineer"
    )
  })

  it("leaves a title the list has never heard of alone", () => {
    expect(canonicalRoleTitle("Staff Platform Engineer (Payments)")).toBe(
      "Staff Platform Engineer (Payments)"
    )
  })

  it("trims, so a stray space cannot become a title of its own", () => {
    expect(canonicalRoleTitle("  Data Engineer  ")).toBe("Data Engineer")
  })

  /**
   * It may only ever change punctuation and case — `normalizeTitle` flattens
   * both, so a match differs in nothing else. Asserted across the whole list
   * because the alternative is a snap that silently rewrites one role into a
   * neighbouring one.
   */
  it("never changes a title into a different title", () => {
    const flatten = (title: string) =>
      title.toLowerCase().replace(/[^a-z0-9]+/g, "")

    for (const title of ROLE_TITLES) {
      expect(flatten(canonicalRoleTitle(title.toUpperCase()))).toBe(
        flatten(title)
      )
    }
  })
})

/**
 * The datalist's option values, which are the awkward part of this feature.
 *
 * A `<datalist>` compares each option against the *whole* input value, so a
 * wrong prefix here does not throw — it silently offers nothing, on a control
 * whose entire job is to offer something. That is why the arithmetic lives in a
 * function rather than in the component.
 */
describe("roleTitleCompletions", () => {
  it("offers bare titles for the first entry", () => {
    expect(roleTitleCompletions("software en")).toContainEqual({
      title: "Software Engineer",
      value: "Software Engineer",
    })
  })

  /** The case a list of bare titles gets wrong: a field already holding one. */
  it("carries the committed entries into every option's value", () => {
    const options = roleTitleCompletions("Data Engineer, software en")

    expect(options[0]).toEqual({
      title: "Software Engineer",
      value: "Data Engineer, Software Engineer",
    })
  })

  it("completes the third entry as readily as the first", () => {
    const options = roleTitleCompletions(
      "Data Engineer, Product Manager, software en"
    )

    expect(options[0]?.value).toBe(
      "Data Engineer, Product Manager, Software Engineer"
    )
  })

  it("normalises the separator of what was already typed", () => {
    expect(
      roleTitleCompletions("Data Engineer ,   software en")[0]?.value
    ).toBe("Data Engineer, Software Engineer")
  })

  /**
   * The moment after a comma is when the user most wants the list and least has
   * anything typed — and an empty fragment must offer nothing rather than the
   * first eight titles alphabetically.
   */
  it("offers nothing immediately after a comma", () => {
    expect(roleTitleCompletions("Data Engineer, ")).toEqual([])
  })

  it("offers nothing for a fragment below the floor", () => {
    expect(roleTitleCompletions("Data Engineer, s")).toEqual([])
  })

  it("honours the limit", () => {
    expect(roleTitleCompletions("engineer", 3)).toHaveLength(3)
  })

  /**
   * Every option's `value` is what the field becomes, so it must round-trip
   * through the same split the action parses with — otherwise picking a
   * completion could produce a value the form then refuses.
   */
  it("produces values that split back into the titles they name", () => {
    const options = roleTitleCompletions("Data Engineer, software en")

    for (const option of options) {
      const parts = option.value.split(",").map((part) => part.trim())

      expect(parts[0]).toBe("Data Engineer")
      expect(parts.at(-1)).toBe(option.title)
    }
  })
})
