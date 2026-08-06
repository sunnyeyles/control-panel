import { AIMessage, HumanMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import { getCurrentTime } from "@workspace/agent-tools/time"
import {
  createAgent,
  type AgentTool,
  type ChatModelLike,
} from "@workspace/agents-core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createResumeTailor,
  RESUME_TAILOR_SYSTEM_PROMPT,
  type CreateResumeTailorOptions,
} from "./resume-tailor.ts"

/**
 * The tool set is the security property, so it is asserted structurally rather
 * than read off the source — the same arrangement as
 * `cover-letter-writer.test.ts`, and for the same reason. What `createAgent`
 * hands to `bindTools` *is* what the model may call, so recording that argument
 * is the whole assertion.
 */
class RecordingModel implements ChatModelLike {
  /** One entry per `bindTools` call. `createAgent` makes exactly one. */
  readonly bound: AgentTool[][] = []
  /** The message lists the model was invoked with, system message first. */
  readonly seen: BaseMessage[][] = []

  constructor(private readonly reply = "# Dev User\n\n## Experience") {}

  bindTools(tools: AgentTool[]): {
    invoke(messages: BaseMessage[]): Promise<AIMessage>
  } {
    this.bound.push(tools)

    return {
      invoke: async (messages: BaseMessage[]): Promise<AIMessage> => {
        this.seen.push(messages)
        return new AIMessage(this.reply)
      },
    }
  }
}

describe("createResumeTailor", () => {
  /**
   * Proves the claim the rest of the suite rests on: nothing here reaches a
   * provider. A factory that fell back to `createModel()` would throw on the
   * missing key rather than silently passing.
   */
  const key = process.env.OPENAI_API_KEY

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
  })

  it("gives the tailor no tools at all", () => {
    const model = new RecordingModel()

    createResumeTailor({ model })

    expect(model.bound).toHaveLength(1)
    expect(model.bound[0]).toEqual([])
  })

  /**
   * The negative control. Without it, `bound[0]` being empty would also be what
   * a `createAgent` that ignored `tools` entirely produced — the assertion above
   * would pass for the wrong reason, and keep passing after someone armed this
   * agent.
   */
  it("records the tools an agent is actually given, so the empty set means something", () => {
    const model = new RecordingModel()

    createAgent({ model, tools: [getCurrentTime] })

    expect(model.bound[0]).toHaveLength(1)
  })

  /**
   * `CreateResumeTailorOptions` omits `tools` from the type, so this is not
   * reachable from typed code — and the factory passes its own `tools: []` last,
   * so it is not reachable by forcing one past the compiler either.
   */
  it("cannot be armed by a caller that forces tools past the type", () => {
    const model = new RecordingModel()
    const tools: AgentTool[] = [getCurrentTime]
    const forced = {
      model,
      tools,
    } as unknown as CreateResumeTailorOptions

    createResumeTailor(forced)

    expect(model.bound[0]).toEqual([])
  })

  it("is a factory, so importing this module needs no API key", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(() =>
      createResumeTailor({ model: new RecordingModel() })
    ).not.toThrow()
  })

  it("sends the resume-tailor system prompt ahead of the request", async () => {
    const model = new RecordingModel()
    const tailor = createResumeTailor({ model })

    const result = await tailor.invoke({
      messages: [new HumanMessage("Rewrite my resume for the posting below.")],
    })

    expect(model.seen[0]?.[0]?.text).toBe(RESUME_TAILOR_SYSTEM_PROMPT)
    expect(result.messages.at(-1)?.text).toBe("# Dev User\n\n## Experience")
  })

  it("takes an overridden system prompt, as every agent here does", () => {
    const model = new RecordingModel()

    createResumeTailor({ model, systemPrompt: "Return nothing." })

    expect(model.bound[0]).toEqual([])
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

  it("tells the model the posting's text is quoted material, not instruction", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/quoted material/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/ignore it/i)
  })

  it("states that it has no tools, so nothing can be looked up", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/no tools/i)
  })

  it("bounds the length and fixes the format", () => {
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/same length as the source/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/markdown/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/no code fence/i)
    expect(RESUME_TAILOR_SYSTEM_PROMPT).toMatch(/no preamble/i)
  })
})
