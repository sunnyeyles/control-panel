import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import {
  createMatchAssessor,
  MATCH_ASSESSOR_SYSTEM_PROMPT,
} from "./match-assessor.ts"
import { expectSharedPromptGuards } from "./test-support/prompt-guards.ts"
import { RecordingModel } from "./test-support/recording-model.ts"

/**
 * The tool-lessness of this agent is `defineToollessAgent`'s contract, proven
 * once in `agent-options.test.ts`. What this suite owns is that the factory
 * wires the *assessor's* prompt as the default, and that no caller can arm it.
 */
describe("createMatchAssessor", () => {
  it("sends the match-assessor system prompt ahead of the request", async () => {
    const model = new RecordingModel('{"score":70,"reason":"x","gaps":[]}')
    const assessor = createMatchAssessor({ model })

    const result = await assessor.invoke({
      messages: [new HumanMessage("Score how well I match the posting below.")],
    })

    expect(model.seen[0]?.[0]?.text).toBe(MATCH_ASSESSOR_SYSTEM_PROMPT)
    expect(result.messages.at(-1)?.text).toBe(
      '{"score":70,"reason":"x","gaps":[]}'
    )
  })

  /**
   * ⚠️ **The containment, asserted where the argument for it lives.** This
   * agent holds the candidate's CV and an attacker-influenced advertisement in
   * one context; an agent that could both read a CV and issue an outbound
   * request can be induced to put one inside the other. `defineToollessAgent`
   * passes the empty set *after* the caller's options, so this holds even for a
   * caller that forced `tools` past the compiler.
   */
  it("binds no tools at all", async () => {
    const model = new RecordingModel('{"score":1,"reason":"x","gaps":[]}')

    await createMatchAssessor({ model }).invoke({
      messages: [new HumanMessage("Score it.")],
    })

    expect(model.bound).toEqual([[]])
  })
})

/**
 * The prompt is where every scoring rule exists. The schema bounds the number
 * and says nothing about what it means, so a rule dropped from here is a
 * silently different score rather than a validation failure — which is why
 * these are asserted one clause at a time.
 */
describe("MATCH_ASSESSOR_SYSTEM_PROMPT", () => {
  it("carries the guards every tool-less prompt here carries", () => {
    expectSharedPromptGuards(MATCH_ASSESSOR_SYSTEM_PROMPT)
  })

  it("names its two sources and rules out a third", () => {
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(/two sources and no others/i)
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(/nothing to look up/i)
  })

  it("credits only what the resume names, and refuses the adjacent thing", () => {
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(/only what the resume names/i)
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(
      /adjacent thing is not the thing asked for/i
    )
  })

  it("penalises only what the advertisement stated", () => {
    // The other half of the same rule, and the one that keeps a thin
    // advertisement from scoring badly for being thin.
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(
      /penalise only what the advertisement states/i
    )
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(
      /requirement it did not list is not a gap/i
    )
  })

  it("binds every gap to a requirement the advertisement actually stated", () => {
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(
      /requirement the advertisement actually stated/i
    )
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(
      /not career advice|not a list of weaknesses/i
    )
  })

  /**
   * ⚠️ **The bands are what make two scores comparable.** Without them the
   * number is one model's private scale, and a column that sorts on it is
   * sorting on nothing — so every band appears here by name.
   */
  it("states all four bands, with their boundaries", () => {
    for (const band of [/80 to 100/, /60 to 79/, /40 to 59/, /0 to 39/]) {
      expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(band)
    }
  })

  it("scores an advertisement with nothing in it conservatively rather than generously", () => {
    // The failure mode the band table alone invites: a teaser states almost no
    // requirements, so there is nothing to fail to evidence, and "everything
    // lines up" is the wrong reading of "nothing was asked".
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(
      /conservatively rather than generously/i
    )
  })

  it("asks for JSON and embeds the schema it will be parsed against", () => {
    expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toMatch(/JSON and nothing else/i)
    for (const field of ["score", "reason", "gaps"]) {
      expect(MATCH_ASSESSOR_SYSTEM_PROMPT).toContain(field)
    }
  })
})
