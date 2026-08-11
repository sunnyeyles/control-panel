/**
 * The loop, and the two ways out of it.
 *
 * `createAgent` compiles a graph whose whole job is to keep going until the
 * model stops asking for tools — or until the budget runs out, at which point
 * `halt` has to leave the transcript in a state a provider will accept. Neither
 * condition is reachable from a unit test of any single function, which is why
 * these run the compiled graph.
 *
 * No provider key is involved: `ChatModelLike` states the two methods the graph
 * calls, and {@link scriptedModel} supplies them. That the interface is small
 * enough to fake in a dozen lines is the property being exercised here as much
 * as any assertion below.
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import type { ToolCall } from "@langchain/core/messages/tool"
import type { RunnableConfig } from "@langchain/core/runnables"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"

import {
  createAgent,
  DEFAULT_SYSTEM_PROMPT,
  type ChatModelLike,
} from "./agent.ts"
import type { AgentTool } from "./tools.ts"

/**
 * A model that plays a fixed script of turns, so a run is deterministic and
 * costs nothing. It records every message list it was handed, which is how the
 * prompt and the growing transcript are asserted on below.
 *
 * Runs off the end of the script by answering with plain text, which ends the
 * run — a script that under-provides turns fails on the assertion rather than
 * hanging.
 */
function scriptedModel(turns: AIMessage[]) {
  const seen: BaseMessage[][] = []
  let boundTools: AgentTool[] = []
  let index = 0

  const model: ChatModelLike = {
    bindTools(tools) {
      boundTools = tools
      return {
        async invoke(messages) {
          seen.push(messages)
          const turn = turns[index]
          index += 1
          return turn ?? new AIMessage({ content: "done" })
        },
      }
    },
  }

  return {
    model,
    /** Every message list the model was invoked with, in order. */
    get seen() {
      return seen
    },
    /** What `createAgent` handed to `bindTools`. */
    get boundTools() {
      return boundTools
    },
    get calls() {
      return seen.length
    },
  }
}

function toolCall(name: string, id = `call_${name}`): ToolCall {
  return { id, name, args: {}, type: "tool_call" }
}

function callTurn(...calls: ToolCall[]): AIMessage {
  return new AIMessage({ content: "", tool_calls: calls })
}

/**
 * A tool the registry can dispatch. See the note on `rawTool` in
 * `tools.test.ts` for why this is a cast and not an implementation.
 */
function fakeTool(
  name: string,
  run: (config?: RunnableConfig) => unknown = () => `${name} ran`
): AgentTool {
  return {
    name,
    invoke: async (_call: ToolCall, config?: RunnableConfig) => run(config),
  } as unknown as AgentTool
}

const HELLO = { messages: [new HumanMessage("hello")] }

function toolMessages(messages: BaseMessage[]): ToolMessage[] {
  return messages.filter((message): message is ToolMessage =>
    ToolMessage.isInstance(message)
  )
}

describe("createAgent", () => {
  it("answers without touching a tool when the model does not ask for one", async () => {
    const script = scriptedModel([new AIMessage({ content: "42" })])
    const agent = createAgent({ model: script.model })

    const result = await agent.invoke(HELLO)

    expect(script.calls).toBe(1)
    expect(result.messages.at(-1)?.content).toBe("42")
    expect(toolMessages(result.messages)).toHaveLength(0)
  })

  it("puts the system prompt in front of the conversation, not in it", async () => {
    // The prompt is prepended on every model call rather than pushed into
    // state, so it never accumulates and never reaches a checkpointer.
    const script = scriptedModel([new AIMessage({ content: "hi" })])
    const agent = createAgent({ model: script.model })

    const result = await agent.invoke(HELLO)

    expect(script.seen[0]?.[0]?.content).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(script.seen[0]?.[1]?.content).toBe("hello")
    expect(result.messages.map((message) => message.content)).not.toContain(
      DEFAULT_SYSTEM_PROMPT
    )
  })

  it("takes a system prompt of its own", async () => {
    const script = scriptedModel([new AIMessage({ content: "aye" })])
    const agent = createAgent({
      model: script.model,
      systemPrompt: "You are a pirate.",
    })

    await agent.invoke(HELLO)

    expect(script.seen[0]?.[0]?.content).toBe("You are a pirate.")
  })

  it("binds no tools by default", async () => {
    // This package ships none deliberately — a consumer supplies its own.
    const script = scriptedModel([new AIMessage({ content: "hi" })])
    createAgent({ model: script.model })

    expect(script.boundTools).toEqual([])
  })

  it("runs a tool and comes back to the model with its result", async () => {
    const script = scriptedModel([
      callTurn(toolCall("clock")),
      new AIMessage({ content: "it is noon" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("clock", () => "noon")],
    })

    const result = await agent.invoke(HELLO)

    expect(script.calls).toBe(2)
    // The second model call sees the tool's answer, which is the whole point
    // of looping back rather than ending on the tool node.
    expect(script.seen[1]?.at(-1)?.content).toBe("noon")
    expect(result.messages.at(-1)?.content).toBe("it is noon")
  })

  it("answers every call in a parallel turn, each against its own id", async () => {
    // Claude emits several tool calls at once; one unanswered id invalidates
    // the whole next turn, so the node returns them in a single update.
    const script = scriptedModel([
      callTurn(toolCall("one"), toolCall("two")),
      new AIMessage({ content: "both done" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("one"), fakeTool("two")],
    })

    const result = await agent.invoke(HELLO)

    expect(
      toolMessages(result.messages).map((message) => message.tool_call_id)
    ).toEqual(["call_one", "call_two"])
  })

  it("keeps going when a tool fails, because the failure is a message", async () => {
    const script = scriptedModel([
      callTurn(toolCall("flaky")),
      new AIMessage({ content: "I could not look that up" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [
        fakeTool("flaky", () => {
          throw new Error("upstream 503")
        }),
      ],
    })

    const result = await agent.invoke(HELLO)

    const [failure] = toolMessages(result.messages)
    expect(failure?.status).toBe("error")
    expect(failure?.content).toContain("upstream 503")
    expect(result.messages.at(-1)?.content).toBe("I could not look that up")
  })

  it("forwards the node's config so a tool can write to the run's stream", async () => {
    let seen: RunnableConfig | undefined
    const script = scriptedModel([
      callTurn(toolCall("peek")),
      new AIMessage({ content: "done" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [
        fakeTool("peek", (config) => {
          seen = config
          return "ok"
        }),
      ],
    })

    await agent.invoke(HELLO)

    // A `config.writer` is what LangGraph puts here; its presence at all is
    // what this asserts, since the node passing `undefined` is the regression.
    expect(seen).toBeDefined()
  })
})

describe("the model-call budget", () => {
  it("counts model calls across tool round trips", async () => {
    const script = scriptedModel([
      callTurn(toolCall("loop")),
      callTurn(toolCall("loop")),
      new AIMessage({ content: "enough" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("loop")],
      maxLlmCalls: 5,
    })

    const result = await agent.invoke(HELLO)

    // Absolute increments on an untracked channel — a write that replaced with
    // `1` every time would leave this at 1 and no run would ever halt.
    expect(result.llmCalls).toBe(3)
  })

  it("halts a model that will not stop calling tools", async () => {
    const script = scriptedModel([
      callTurn(toolCall("loop")),
      callTurn(toolCall("loop")),
      callTurn(toolCall("loop")),
      callTurn(toolCall("loop")),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("loop")],
      maxLlmCalls: 2,
    })

    const result = await agent.invoke(HELLO)

    expect(script.calls).toBe(2)
    expect(result.llmCalls).toBe(2)
  })

  it("answers the outstanding calls on the way out, so the transcript stays valid", async () => {
    // ⚠️ The reason `halt` is a node rather than an edge to END. The turn that
    // exhausted the budget still carries tool calls, and a checkpointed thread
    // resumed with those unanswered is rejected by the provider.
    const script = scriptedModel([
      callTurn(toolCall("one"), toolCall("two")),
      callTurn(toolCall("one")),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("one"), fakeTool("two")],
      maxLlmCalls: 1,
    })

    const result = await agent.invoke(HELLO)

    const answers = toolMessages(result.messages)
    expect(answers.map((message) => message.tool_call_id)).toEqual([
      "call_one",
      "call_two",
    ])
    expect(answers.every((message) => message.status === "error")).toBe(true)
    // The budget is named in the text because the model may get this back on a
    // resumed thread and should not retry into the same wall.
    expect(answers[0]?.content).toContain("budget of 1 model calls")
  })

  it("does not halt a run that finished inside its budget", async () => {
    const script = scriptedModel([
      callTurn(toolCall("one")),
      new AIMessage({ content: "finished" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("one")],
      maxLlmCalls: 2,
    })

    const result = await agent.invoke(HELLO)

    // Exactly at the ceiling, and the router asks about pending calls first —
    // so a run whose last turn is plain text ends normally rather than halting.
    expect(result.llmCalls).toBe(2)
    expect(
      toolMessages(result.messages).some(
        (message) => message.status === "error"
      )
    ).toBe(false)
  })

  it("does not carry a prior invoke's budget into the next turn of a thread", async () => {
    // The whole point of `UntrackedValue`: messages resume; the call counter
    // does not. Without that, turn 2 of a MemorySaver thread would inherit
    // turn 1's burn and shrink the documented "runaway loop" budget into a
    // lifetime-of-thread budget.
    const script = scriptedModel([
      callTurn(toolCall("loop")),
      new AIMessage({ content: "first" }),
      callTurn(toolCall("loop")),
      new AIMessage({ content: "second" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("loop")],
      checkpointer: new MemorySaver(),
      maxLlmCalls: 2,
    })
    const config = { configurable: { thread_id: "budget-reset" } }

    await agent.invoke(HELLO, config)
    const second = await agent.invoke(
      { messages: [new HumanMessage("again")] },
      config
    )

    // Fresh budget each invoke: two calls for the second turn, not a halt on
    // the first tool call because turn 1 already spent the thread's "lifetime".
    expect(script.calls).toBe(4)
    expect(second.llmCalls).toBe(2)
    expect(second.messages.at(-1)?.content).toBe("second")
  })

  it("reports an unknown tool to the model instead of throwing", async () => {
    const script = scriptedModel([
      callTurn(toolCall("nonexistent")),
      new AIMessage({ content: "sorry" }),
    ])
    const agent = createAgent({
      model: script.model,
      tools: [fakeTool("real")],
    })

    const result = await agent.invoke(HELLO)

    const [failure] = toolMessages(result.messages)
    expect(failure?.status).toBe("error")
    expect(failure?.content).toContain("real")
  })
})
