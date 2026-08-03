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
  COVER_LETTER_WRITER_SYSTEM_PROMPT,
  createCoverLetterWriter,
  type CreateCoverLetterWriterOptions,
} from "./cover-letter-writer.ts"

/**
 * The tool set is the security property, so it is asserted structurally rather
 * than read off the source.
 *
 * `ChatModelLike` in `@workspace/agents-core` is a structural interface for
 * exactly this: a fake satisfies it, so the factory can be driven — through the
 * real `createAgent`, the real graph — with no provider key and no network.
 * What `createAgent` hands to `bindTools` *is* what the model may call, so
 * recording that argument is the whole assertion.
 */
class RecordingModel implements ChatModelLike {
  /** One entry per `bindTools` call. `createAgent` makes exactly one. */
  readonly bound: AgentTool[][] = []
  /** The message lists the model was invoked with, system message first. */
  readonly seen: BaseMessage[][] = []

  constructor(private readonly reply = "Dear Hiring Team, ...") {}

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

describe("createCoverLetterWriter", () => {
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

  it("gives the writer no tools at all", () => {
    const model = new RecordingModel()

    createCoverLetterWriter({ model })

    expect(model.bound).toHaveLength(1)
    expect(model.bound[0]).toEqual([])
  })

  /**
   * The negative control. Without it, `bound[0]` being empty would also be
   * what a `createAgent` that ignored `tools` entirely produced — the
   * assertion above would pass for the wrong reason, and keep passing after
   * someone armed this agent.
   */
  it("records the tools an agent is actually given, so the empty set means something", () => {
    const model = new RecordingModel()

    createAgent({ model, tools: [getCurrentTime] })

    expect(model.bound[0]).toHaveLength(1)
  })

  /**
   * `CreateCoverLetterWriterOptions` omits `tools` from the type, so this is
   * not reachable from typed code — and the factory passes its own `tools: []`
   * last, so it is not reachable by forcing one past the compiler either.
   */
  it("cannot be armed by a caller that forces tools past the type", () => {
    const model = new RecordingModel()
    const tools: AgentTool[] = [getCurrentTime]
    const forced = {
      model,
      tools,
    } as unknown as CreateCoverLetterWriterOptions

    createCoverLetterWriter(forced)

    expect(model.bound[0]).toEqual([])
  })

  it("is a factory, so importing this module needs no API key", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(() =>
      createCoverLetterWriter({ model: new RecordingModel() })
    ).not.toThrow()
  })

  it("sends the cover-letter system prompt ahead of the request", async () => {
    const model = new RecordingModel()
    const writer = createCoverLetterWriter({ model })

    const result = await writer.invoke({
      messages: [
        new HumanMessage("Write my cover letter for the posting below."),
      ],
    })

    expect(model.seen[0]?.[0]?.text).toBe(COVER_LETTER_WRITER_SYSTEM_PROMPT)
    expect(result.messages.at(-1)?.text).toBe("Dear Hiring Team, ...")
  })

  it("takes an overridden system prompt, as every agent here does", () => {
    const model = new RecordingModel()

    createCoverLetterWriter({ model, systemPrompt: "Write nothing." })

    expect(model.bound[0]).toEqual([])
  })
})

/**
 * The prompt is the only place the letter's honesty rules exist — the agent has
 * no tools and no schema to enforce them. These assertions are deliberately
 * about the requirements the ticket enumerates, so that dropping one is a test
 * failure rather than a silently worse letter.
 */
describe("COVER_LETTER_WRITER_SYSTEM_PROMPT", () => {
  it("asks for the first person, as the candidate", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/first person/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/as the candidate/i)
  })

  it("ties every claim about the candidate to the background text", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(
      /traceable to the background/i
    )
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/employer/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/years/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/metric/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/technology/i)
  })

  it("ties everything about the role to the posting record", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(
      /about the role must come from the posting record/i
    )
  })

  it("requires a bracketed placeholder where a fact was not supplied", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/bracketed placeholder/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toContain("[start date]")
  })

  it("names the salutation, and when to depart from it", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toContain("Dear Hiring Team")
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/names a recipient/i)
  })

  it("bounds the length and fixes the format", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/250 and 350 words/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/markdown/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/no code fence/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/no preamble/i)
  })

  it("tells the model the posting's text is quoted material, not instruction", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/ignore it/i)
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/quoted material/i)
  })

  it("states that it has no tools, so nothing can be looked up", () => {
    expect(COVER_LETTER_WRITER_SYSTEM_PROMPT).toMatch(/no tools/i)
  })
})
