import { describe, expect, it } from "vitest"

import { findExperienceStatement } from "./experience.ts"

/**
 * The rule for reading an experience requirement off an advertisement nobody
 * gave to a model.
 *
 * ⚠️ **Two properties are asserted here and only one of them is the obvious
 * one.** What it finds matters, and so does what it refuses: a duration in an
 * advertisement is very often about something other than the candidate, and a
 * fabricated requirement in a column somebody filters on is worse than a blank
 * one. Half of the cases below are refusals for that reason.
 *
 * Every answer is checked as a *substring of the input*, because the field is
 * the advertisement's own words. A value this function composed rather than
 * copied would be exactly the invention the whole Posting contract refuses.
 */
describe("findExperienceStatement", () => {
  it("takes an open-ended requirement", () => {
    expect(findExperienceStatement("5+ years of experience with React")).toBe(
      "5+ years of experience"
    )
  })

  it("takes a qualifier in front of the number", () => {
    expect(
      findExperienceStatement(
        "You will have at least 3 years in a similar role"
      )
    ).toBe("at least 3 years in a similar role")

    expect(
      findExperienceStatement("A minimum of 4 years experience is required")
    ).toBe("A minimum of 4 years experience")
  })

  it("takes a range", () => {
    expect(findExperienceStatement("3-5 years experience in Go")).toBe(
      "3-5 years experience"
    )
    expect(findExperienceStatement("We want 2 to 4 years of experience")).toBe(
      "2 to 4 years of experience"
    )
  })

  it("takes a number spelled out", () => {
    expect(
      findExperienceStatement("Ideally two years of commercial experience")
    ).toBe("two years of commercial experience")
  })

  it("takes a possessive, which is how half of them are written", () => {
    expect(
      findExperienceStatement("Minimum 6 years' experience in a similar role")
    ).toBe("Minimum 6 years' experience")
  })

  it("reads the bullet points as well as the summary", () => {
    const advertisement = [
      "A backend role on a small team.",
      "- Own a service end to end",
      "- 7+ years of experience building distributed systems",
    ].join("\n")

    expect(findExperienceStatement(advertisement)).toBe(
      "7+ years of experience"
    )
  })

  it("answers nothing when the advertisement states nothing", () => {
    expect(
      findExperienceStatement(
        "A senior role on our platform team. You will own a service end to end."
      )
    ).toBeUndefined()
  })

  /**
   * ⚠️ **The case this function exists to get wrong-proof.** Advertisements are
   * full of durations that are facts about the company, and a bare "5 years"
   * anywhere near the word *experience* would be enough for a looser rule to
   * store one as a requirement.
   */
  it("refuses a duration that is not about the candidate", () => {
    expect(
      findExperienceStatement("We have been building this product for 5 years.")
    ).toBeUndefined()

    expect(
      findExperienceStatement("Founded 10 years ago in Melbourne.")
    ).toBeUndefined()
  })

  it("never invents one from the seniority in the title", () => {
    expect(
      findExperienceStatement("Principal Engineer, Platform — Sydney")
    ).toBeUndefined()
  })

  it("answers nothing for an empty document", () => {
    expect(findExperienceStatement("")).toBeUndefined()
    expect(findExperienceStatement("   \n  ")).toBeUndefined()
  })

  it("returns a substring of what it was given, never a composition", () => {
    const advertisement =
      "Requirements: at least 5 years of hands-on experience with Kubernetes."
    const found = findExperienceStatement(advertisement)

    expect(found).toBeDefined()
    expect(advertisement).toContain(found)
  })

  /**
   * ⚠️ **The match cannot run away into the rest of the sentence.** Both ends
   * are bounded — a qualifier is taken only where it sits directly in front of
   * the number, and the tail is at most five words — so what comes back stays a
   * phrase rather than becoming a clause with the boundaries misread. A
   * fragment that reads like a requirement is worse in a column somebody acts
   * on than no requirement at all, which is what the length cap in the module
   * is the backstop for.
   */
  it("keeps the match to a phrase at both ends", () => {
    // "at least" is not glued on across the words between it and the number.
    expect(
      findExperienceStatement("at least, in the ideal case, 5 years experience")
    ).toBe("5 years experience")

    expect(
      findExperienceStatement(
        "5+ years of experience and a track record of shipping to production every week"
      )
    ).toBe("5+ years of experience")
  })
})
