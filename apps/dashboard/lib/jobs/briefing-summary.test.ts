import type { Job } from "@workspace/db"
import { describe, expect, it } from "vitest"

import { toBriefingSummary } from "./briefing-summary"

/**
 * The projection a server component hands to the cards, and in particular the
 * one branch in it that decides whether a briefing can be edited at all.
 */

const SEEDED_AT = new Date("2026-08-01T00:00:00.000Z")

function briefing(config: unknown): Job {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    name: "Sydney backend roles",
    config,
    scheduleCron: "0 7 * * *",
    scheduleTimezone: "Australia/Sydney",
    nextRunAt: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  } as unknown as Job
}

describe("the criteria projection", () => {
  it("comma-joins each field the edit form renders", () => {
    const summary = toBriefingSummary(
      briefing({
        titles: ["Backend Engineer", "Platform Engineer"],
        locations: ["Sydney", "Remote"],
        keywords: ["TypeScript", "AWS"],
      })
    )

    expect(summary.criteria).toEqual({
      titles: "Backend Engineer, Platform Engineer",
      locations: "Sydney, Remote",
      keywords: "TypeScript, AWS",
    })
  })

  /**
   * Absent keywords and empty keywords are different things in the row — see
   * `readCriteria` — and both are one empty text box in the form. That is fine
   * going in; what matters is that neither becomes the string "undefined".
   */
  it("reads absent keywords as an empty field", () => {
    const summary = toBriefingSummary(
      briefing({ titles: ["Backend Engineer"], locations: ["Sydney"] })
    )

    expect(summary.criteria?.keywords).toBe("")
  })

  /**
   * ⚠️ **The branch this file mostly exists for.** `jobs.config` is untyped
   * JSONB that the platform stores and never reads inside, so a row written by
   * hand — or by a second kind of briefing arriving later with a completely
   * different config — is a legitimate thing to find. It renders as a card with
   * no edit form rather than taking the whole section down with it, and rather
   * than offering to replace a config this app cannot read with three text
   * boxes.
   */
  it.each([
    ["an empty object", {}],
    ["no titles", { locations: ["Sydney"] }],
    ["no locations", { titles: ["Backend Engineer"] }],
    ["an empty titles list", { titles: [], locations: ["Sydney"] }],
    ["a config for some other kind of briefing", { topic: "AI news" }],
    ["null", null],
    ["a string", "backend engineer"],
  ])("carries no criteria for %s", (_label, config) => {
    const summary = toBriefingSummary(briefing(config))

    expect(summary.criteria).toBeUndefined()
    // The rest of the card still renders — the name and the schedule are read
    // off columns, not out of the config.
    expect(summary.name).toBe("Sydney backend roles")
  })

  /**
   * A row from before the form capped titles at three parses fine and is
   * projected whole. The edit form shows all of them and refuses to *save*
   * until they are trimmed; the worker keeps running it as it is. Truncating
   * here would make the form silently lose two titles on the next save.
   */
  it("projects more titles than the form now permits, rather than trimming", () => {
    const summary = toBriefingSummary(
      briefing({
        titles: ["One", "Two", "Three", "Four", "Five"],
        locations: ["Sydney"],
      })
    )

    expect(summary.criteria?.titles).toBe("One, Two, Three, Four, Five")
  })
})
