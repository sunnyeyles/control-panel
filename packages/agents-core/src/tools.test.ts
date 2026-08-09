/**
 * The registry is where a run stops being well-formed or stays that way.
 *
 * Every provider rejects a transcript in which a tool call went unanswered, so
 * `dispatch` promises a `ToolMessage` for *any* input — an unknown name, a tool
 * that throws, a tool that returns something that is not a string. Those are
 * not edge cases to tidy up later; they are the reason the function exists, and
 * each one below is a turn the model would otherwise never get to take.
 */

import { ToolMessage } from "@langchain/core/messages"
import type { ToolCall } from "@langchain/core/messages/tool"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import * as z from "zod"
import { describe, expect, it } from "vitest"

import {
  createToolRegistry,
  errorToolMessage,
  type AgentTool,
} from "./tools.ts"

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${name}`, name, args, type: "tool_call" }
}

/** A tool built the way every real caller builds one. */
function echoTool(name = "echo") {
  return tool(({ text }: { text: string }) => `echoed: ${text}`, {
    name,
    description: "Echoes its input.",
    schema: z.object({ text: z.string() }),
  })
}

/**
 * A tool that is *not* a LangChain `tool()`.
 *
 * `AgentTool` is `StructuredToolInterface`, and the registry only ever reaches
 * for `.name` and `.invoke` — which is the whole point of typing the catalog
 * structurally. `tool()` wraps its return value in a `ToolMessage` before
 * `dispatch` ever sees it, so the raw-value branches of `toToolMessage` are
 * unreachable through it. The cast says plainly that the rest of the interface
 * is not read rather than pretending to implement it.
 */
function rawTool(
  name: string,
  run: (call: ToolCall, config?: RunnableConfig) => unknown
): AgentTool {
  return {
    name,
    invoke: async (call: ToolCall, config?: RunnableConfig) =>
      run(call, config),
  } as unknown as AgentTool
}

describe("createToolRegistry", () => {
  it("rejects two tools sharing a name", () => {
    // Indexing by name means the second would silently shadow the first, and
    // the model would go on describing whichever docstring it was given.
    expect(() => createToolRegistry([echoTool(), echoTool()])).toThrow(
      /Duplicate tool name in registry: "echo"/
    )
  })

  it("passes the tool list through for bindTools", () => {
    const tools = [echoTool("one"), echoTool("two")]
    expect(createToolRegistry(tools).tools).toBe(tools)
  })

  it("accepts an empty catalog", () => {
    // `createAgent` defaults to no tools, so this is the ordinary case for a
    // consumer that brought only a prompt.
    expect(createToolRegistry([]).tools).toEqual([])
  })
})

describe("dispatch", () => {
  it("runs the named tool and answers the call that asked for it", async () => {
    const registry = createToolRegistry([echoTool()])

    const message = await registry.dispatch({
      ...toolCall("echo"),
      args: { text: "hello" },
    })

    expect(message.status).not.toBe("error")
    expect(message.content).toContain("echoed: hello")
    expect(message.tool_call_id).toBe("call_echo")
  })

  it("answers an unknown tool with an error naming what it could have called", async () => {
    const registry = createToolRegistry([echoTool("one"), echoTool("two")])

    const message = await registry.dispatch(toolCall("three"))

    expect(message.status).toBe("error")
    expect(message.tool_call_id).toBe("call_three")
    // The list is the useful half: a model that misremembered a name can
    // correct itself on the next turn rather than repeating the mistake.
    expect(message.content).toContain("one, two")
  })

  it("turns a throwing tool into an error message rather than failing the run", async () => {
    const registry = createToolRegistry([
      rawTool("boom", () => {
        throw new Error("the network said no")
      }),
    ])

    const message = await registry.dispatch(toolCall("boom"))

    expect(message.status).toBe("error")
    expect(message.content).toContain("the network said no")
  })

  it("survives a tool that throws something that is not an Error", async () => {
    const registry = createToolRegistry([
      rawTool("boom", () => {
        throw "just a string"
      }),
    ])

    const message = await registry.dispatch(toolCall("boom"))

    expect(message.status).toBe("error")
    expect(message.content).toContain("just a string")
  })

  it("serialises a non-string result", async () => {
    const registry = createToolRegistry([
      rawTool("json", () => ({ temperature: 21, unit: "C" })),
    ])

    const message = await registry.dispatch(toolCall("json"))

    expect(message.content).toBe(JSON.stringify({ temperature: 21, unit: "C" }))
  })

  it("passes a ToolMessage straight through", async () => {
    // A tool that wants to set `status` or an `artifact` builds the message
    // itself; re-wrapping it would throw that away.
    const built = new ToolMessage({
      tool_call_id: "call_own",
      name: "own",
      content: "handled",
      status: "error",
    })
    const registry = createToolRegistry([rawTool("own", () => built)])

    expect(await registry.dispatch(toolCall("own"))).toBe(built)
  })

  it("tolerates a tool call with no id", async () => {
    const registry = createToolRegistry([rawTool("anon", () => "fine")])

    const message = await registry.dispatch({
      name: "anon",
      args: {},
      type: "tool_call",
    })

    expect(message.tool_call_id).toBe("")
  })

  it("forwards the node's config so a tool can reach the run's stream", async () => {
    // ⚠️ Nothing typechecks this, and it is the coupling `whiteboard.test.ts`
    // in `@workspace/agents` exists for: drop the second argument and every
    // tool still succeeds while the browser stops receiving anything.
    let seen: RunnableConfig | undefined
    const registry = createToolRegistry([
      rawTool("peek", (_call, config) => {
        seen = config
        return "ok"
      }),
    ])

    await registry.dispatch(toolCall("peek"), { runName: "the-run" })

    expect(seen?.runName).toBe("the-run")
  })
})

describe("errorToolMessage", () => {
  it("marks the message as an error against the call it answers", () => {
    const message = errorToolMessage(toolCall("thing"), "could not")

    expect(message.status).toBe("error")
    expect(message.tool_call_id).toBe("call_thing")
    expect(message.name).toBe("thing")
    expect(message.content).toBe("could not")
  })
})
