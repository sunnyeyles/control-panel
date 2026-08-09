import { HumanMessage } from "@langchain/core/messages"
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createAgent, type AgentTool } from "@workspace/agents-core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  defineToollessAgent,
  type ToollessAgentOptions,
} from "./agent-options.ts"
import { RecordingModel } from "./test-support/recording-model.ts"

/**
 * The tool set is the security property, and every tool-less factory in this
 * package is `defineToollessAgent`'s output — so the properties are proven
 * once, here, against the one implementation, instead of once per agent
 * against four copies of it. Each agent's own suite keeps only what this one
 * cannot see: that *its* prompt is the default.
 */
describe("defineToollessAgent", () => {
  const PROMPT = "You are a test agent with nothing to call."
  const create = defineToollessAgent(PROMPT)

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

  it("gives the agent no tools at all", () => {
    const model = new RecordingModel()

    create({ model })

    expect(model.bound).toHaveLength(1)
    expect(model.bound[0]).toEqual([])
  })

  /**
   * The negative control. Without it, `bound[0]` being empty would also be
   * what a `createAgent` that ignored `tools` entirely produced — the
   * assertion above would pass for the wrong reason, and keep passing after
   * someone armed an agent built from this.
   */
  it("records the tools an agent is actually given, so the empty set means something", () => {
    const model = new RecordingModel()

    createAgent({ model, tools: [getCurrentTime] })

    expect(model.bound[0]).toHaveLength(1)
  })

  /**
   * `ToollessAgentOptions` omits `tools` from the type, so this is not
   * reachable from typed code — and the factory passes its own `tools: []`
   * after the spread, so it is not reachable by forcing one past the compiler
   * either.
   */
  it("cannot be armed by a caller that forces tools past the type", () => {
    const model = new RecordingModel()
    const tools: AgentTool[] = [getCurrentTime]
    const forced = { model, tools } as unknown as ToollessAgentOptions

    create(forced)

    expect(model.bound[0]).toEqual([])
  })

  it("builds factories, so constructing one needs no API key", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(() => create({ model: new RecordingModel() })).not.toThrow()
  })

  it("sends its default system prompt ahead of the request", async () => {
    const model = new RecordingModel("Done.")
    const agent = create({ model })

    const result = await agent.invoke({
      messages: [new HumanMessage("Do the thing.")],
    })

    expect(model.seen[0]?.[0]?.text).toBe(PROMPT)
    expect(result.messages.at(-1)?.text).toBe("Done.")
  })

  it("takes an overridden system prompt, without touching the tool set", async () => {
    const model = new RecordingModel()
    const agent = create({ model, systemPrompt: "Say nothing." })

    await agent.invoke({ messages: [new HumanMessage("Do the thing.")] })

    expect(model.seen[0]?.[0]?.text).toBe("Say nothing.")
    expect(model.bound[0]).toEqual([])
  })
})
