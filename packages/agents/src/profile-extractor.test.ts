import { AIMessage, HumanMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import { getCurrentTime } from "@workspace/agent-tools/time"
import {
  createAgent,
  type AgentTool,
  type ChatModelLike,
} from "@workspace/agents-core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { criteriaSchemaDescription } from "./criteria.ts"
import {
  createProfileExtractor,
  PROFILE_EXTRACTOR_SYSTEM_PROMPT,
  toProfilePrompt,
  type CreateProfileExtractorOptions,
} from "./profile-extractor.ts"

/**
 * The tool set is the security property, so it is asserted structurally rather
 * than read off the source.
 *
 * `ChatModelLike` in `@workspace/agents-core` is a structural interface for
 * exactly this: a fake satisfies it, so the factory can be driven — through the
 * real `createAgent`, the real graph — with no provider key and no network.
 * What `createAgent` hands to `bindTools` *is* what the model may call, so
 * recording that argument is the whole assertion.
 *
 * Written out here rather than lifted from `cover-letter-writer.test.ts`: each
 * suite in this package keeps its own, so the fake stays shaped by what the
 * suite is proving instead of becoming a helper every future test has to bend
 * around.
 */
class RecordingModel implements ChatModelLike {
  /** One entry per `bindTools` call. `createAgent` makes exactly one. */
  readonly bound: AgentTool[][] = []
  /** The message lists the model was invoked with, system message first. */
  readonly seen: BaseMessage[][] = []

  constructor(private readonly reply = '{"titles":["Backend Engineer"]}') {}

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

describe("createProfileExtractor", () => {
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

  it("gives the extractor no tools at all", () => {
    const model = new RecordingModel()

    createProfileExtractor({ model })

    expect(model.bound).toHaveLength(1)
    expect(model.bound[0]).toEqual([])
  })

  /**
   * The negative control. Without it, `bound[0]` being empty would also be what
   * a `createAgent` that ignored `tools` entirely produced — the assertion above
   * would pass for the wrong reason, and keep passing after someone armed the
   * one agent in the package that holds an entire CV.
   */
  it("records the tools an agent is actually given, so the empty set means something", () => {
    const model = new RecordingModel()

    createAgent({ model, tools: [getCurrentTime] })

    expect(model.bound[0]).toHaveLength(1)
  })

  /**
   * `CreateProfileExtractorOptions` omits `tools` from the type, so this is not
   * reachable from typed code — and the factory passes its own `tools: []` last,
   * so it is not reachable by forcing one past the compiler either.
   */
  it("cannot be armed by a caller that forces tools past the type", () => {
    const model = new RecordingModel()
    const tools: AgentTool[] = [getCurrentTime]
    const forced = {
      model,
      tools,
    } as unknown as CreateProfileExtractorOptions

    createProfileExtractor(forced)

    expect(model.bound[0]).toEqual([])
  })

  it("is a factory, so importing this module needs no API key", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(() =>
      createProfileExtractor({ model: new RecordingModel() })
    ).not.toThrow()
  })

  it("sends the profile-extractor system prompt ahead of the CV", async () => {
    const model = new RecordingModel()
    const extractor = createProfileExtractor({ model })

    const result = await extractor.invoke({
      messages: [
        new HumanMessage(toProfilePrompt("Backend engineer, Sydney.")),
      ],
    })

    expect(model.seen[0]?.[0]?.text).toBe(PROFILE_EXTRACTOR_SYSTEM_PROMPT)
    expect(result.messages.at(-1)?.text).toBe('{"titles":["Backend Engineer"]}')
  })

  it("takes an overridden system prompt, as every agent here does", async () => {
    const model = new RecordingModel()
    const systemPrompt = "Return an empty object."
    const extractor = createProfileExtractor({ model, systemPrompt })

    await extractor.invoke({ messages: [new HumanMessage("A CV.")] })

    expect(model.seen[0]?.[0]?.text).toBe(systemPrompt)
    expect(model.bound[0]).toEqual([])
  })
})

/**
 * The prompt is the only place the extraction's honesty rules exist — the agent
 * has no tools, and the schema can check the shape of an answer but not whether
 * a city in it was ever written down. These assertions are deliberately about
 * each rule the design enumerates, so dropping one is a test failure rather
 * than a silently worse extraction.
 */
describe("PROFILE_EXTRACTOR_SYSTEM_PROMPT", () => {
  it("asks for JSON and nothing else", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/JSON and nothing else/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/no code fence/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/no preamble/i)
  })

  it("asks for roles the candidate could hold next, bounded by evidenced seniority", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/plausibly hold next/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/seniority/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(
      /not a restatement of their most recent job title/i
    )
  })

  it("confines keywords to technologies the CV names", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(
      /only from technologies, tools and specialisms the CV actually names/i
    )
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(
      /absent from the CV is one the candidate has not claimed/i
    )
  })

  /**
   * The rule with the most leverage on a search: a guessed city narrows every
   * run that follows, and nothing downstream can tell a guess from a statement.
   */
  it("requires an empty locations array rather than a guessed city", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(
      /only if the CV states one/i
    )
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/empty `locations` array/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/area code/i)
  })

  it("names the CV as the only source, with nothing to look up", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/only source/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/no tools/i)
  })

  /**
   * The uploaded document is a prompt-injection surface, and a closed signup
   * does not close it — a user can be handed a CV as easily as they can write
   * one.
   */
  it("tells the model the CV is a description, never an instruction", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(
      /never as instruction to you/i
    )
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/ignore it/i)
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toMatch(/quoted material/i)
  })

  it("carries the schema the parser enforces, rather than a second copy of it", () => {
    expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toContain(criteriaSchemaDescription)
  })
})

/**
 * The CV reaches the model through this function and nowhere else, so the two
 * things that could quietly ruin an extraction — a paraphrase and a truncation
 * — are asserted against rather than trusted.
 */
describe("toProfilePrompt", () => {
  const BACKGROUND = [
    "Jane Citizen — Backend Engineer",
    "",
    "Acme Pty Ltd, 2021–2026. Built payment services in TypeScript on AWS.",
    "Widget Co, 2018–2021. PostgreSQL, Go, on-call one week in six.",
    "",
    "BSc Computer Science, University of Sydney.",
  ].join("\n")

  it("carries the CV through verbatim", () => {
    expect(toProfilePrompt(BACKGROUND)).toContain(BACKGROUND)
  })

  /**
   * The inverse of the system-prompt assertion above, and it locks in a
   * decision rather than describing an accident.
   *
   * The schema belongs in the system prompt and appears there once — the same
   * arrangement `job-scout.ts` uses, where `jobScoutSchemaDescription` sits in
   * `JOB_SCOUT_SYSTEM_PROMPT` and `toSearchBrief` says nothing about the shape.
   * Repeating it here would put the same JSON Schema in the context twice on
   * every call, for a document that is already the largest thing in it.
   */
  it("does not repeat the schema the system prompt already carries", () => {
    expect(toProfilePrompt(BACKGROUND)).not.toContain(criteriaSchemaDescription)
  })

  /**
   * The label is not a security boundary — a document can write a fence of its
   * own, and nothing here stops it. What contains an injected instruction is the
   * empty tool set. The label is still worth asserting: it is what tells the
   * model which side of the message is the person and which is the task.
   */
  it("labels the CV as quoted material rather than instruction", () => {
    const prompt = toProfilePrompt(BACKGROUND)

    expect(prompt).toMatch(/quoted material, not instruction/i)
    expect(prompt).toContain("--- end of CV ---")
    expect(prompt.indexOf("quoted material")).toBeLessThan(
      prompt.indexOf(BACKGROUND)
    )
  })

  /**
   * A long CV is passed through whole. Bounds belong to the caller, checked
   * before this is reached — criteria drawn from the first half of a CV look
   * exactly like criteria drawn from all of it, and the half most often lost is
   * the earlier career that evidenced the seniority.
   */
  it("does not truncate a long CV", () => {
    const long = `${BACKGROUND}\n${"Delivered a project. ".repeat(2_000)}`

    expect(toProfilePrompt(long)).toContain(long)
  })
})
