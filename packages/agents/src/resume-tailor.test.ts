import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import {
  createResumeTailor,
  RESUME_TAILOR_SYSTEM_PROMPT,
} from "./resume-tailor.ts"
import { expectSharedPromptGuards } from "./test-support/prompt-guards.ts"
import { RecordingModel } from "./test-support/recording-model.ts"

/**
 * The tool-lessness of this agent is `defineToollessAgent`'s contract, proven
 * once in `agent-options.test.ts`. What this suite owns is that the factory
 * wires the *tailor's* prompt as the default.
 */
describe("createResumeTailor", () => {
  it("sends the resume-tailor system prompt ahead of the request", async () => {
    const model = new RecordingModel("# Dev User\n\n## Experience")
    const tailor = createResumeTailor({ model })

    const result = await tailor.invoke({
      messages: [new HumanMessage("Rewrite my resume for the posting below.")],
    })

    expect(model.seen[0]?.[0]?.text).toBe(RESUME_TAILOR_SYSTEM_PROMPT)
    expect(result.messages.at(-1)?.text).toBe("# Dev User\n\n## Experience")
  })
})

/**
 * The prompt is the only place the tailoring rules exist — the agent has no
 * tools, and its output is prose, so there is no schema to validate against and
 * no source to compare to. These assertions are about the requirements
 * individually, so that dropping one is a test failure rather than a silently
 * worse document.
 */
describe("RESUME_TAILOR_SYSTEM_PROMPT", () => {
  it("asks for a complete, sendable resume rather than a list of changes", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/complete resume/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/not a set of notes/i)
  })

  /**
   * The clause the whole feature turns on, and the one a model is most likely to
   * break: asked to make a CV "fit", it reaches for the advertisement's
   * vocabulary and attaches it to the candidate.
   */
  it("requires every line to have a counterpart in the source resume", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/counterpart/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/employer/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/metric/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/qualification/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/technology/i)
  })

  it("forbids upgrading a claim, by example", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toContain('"worked with"')
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toContain('"led"')
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/familiar with/i)
  })

  /**
   * The prohibition alone would make a cautious model return the resume
   * unchanged, which is a feature that does nothing. What it *may* do has to be
   * as explicit as what it may not.
   */
  it("says plainly what tailoring is allowed to do", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/reorder/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/lead with/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/re-word/i)
  })

  /**
   * The one deliberate departure from the cover letter, which requires a
   * `[bracketed placeholder]` in the same position. Asserted as an absence *and*
   * as an instruction, because only the instruction survives a rewrite.
   */
  it("forbids the bracketed placeholders the cover letter requires", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(
      /do not write bracketed placeholders/i
    )
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toContain('"[metric]"')
  })

  it("carries the candidate's identity and dates through untouched", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/contact details/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(
      /every date and duration exactly/i
    )
  })

  it("bounds the length and fixes the format", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/same length as the source/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/markdown/i)
  })

  it("carries the shared containment clauses", () => {
    expectSharedPromptGuards(RESUME_TAILOR_SYSTEM_PROMPT)
  })
})
