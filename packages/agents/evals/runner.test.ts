/**
 * The runner, driven by a scripted model.
 *
 * One claim here is load-bearing and easy to break by "simplifying": the ops
 * have to be read off the custom stream. `withOps` flushes the session after
 * every tool call and writes the batch to `config.writer`, and a run that is
 * not streaming in `"custom"` mode has no writer — so the flush happens anyway
 * and the ops are discarded. Someone who swapped `.stream()` for `.invoke()`
 * would get a harness that grades an empty op list against every case and
 * reports the agent doing nothing at all.
 */

import { AIMessage } from "@langchain/core/messages"
import type { ToolCall } from "@langchain/core/messages/tool"
import { describe, expect, it } from "vitest"

import { board, shape } from "./cases/support.ts"
import { runTurn } from "./runner.ts"
import type { EvalCase } from "./types.ts"

function scriptedModel(turns: AIMessage[]) {
  let index = 0
  return {
    bindTools() {
      return {
        async invoke(): Promise<AIMessage> {
          const turn = turns[index]
          index += 1
          return turn ?? new AIMessage({ content: "done" })
        },
      }
    },
  }
}

function callTurn(...calls: ToolCall[]): AIMessage {
  return new AIMessage({ content: "", tool_calls: calls })
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, name, args, type: "tool_call" }
}

const KASE: EvalCase = {
  name: "smoke",
  intent: "runner smoke test",
  board: board({ shapes: [shape("s1", "API", 0, 0)] }),
  prompt: "Draw a client that calls the API",
  expect: {},
}

describe("runTurn", () => {
  it("collects the ops the tools wrote to the custom stream", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([
        callTurn(
          toolCall("draw_diagram", {
            nodes: [{ key: "client", text: "Client" }],
            edges: [{ from: "client", to: "s1" }],
          })
        ),
        new AIMessage({ content: "Drawn — a client calling the API." }),
      ]),
    })

    expect(result.ops.map((op) => op.op)).toEqual(["create", "connect"])
  })

  it("reports the board as it stands at the end of the turn", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([
        callTurn(
          toolCall("draw_diagram", {
            nodes: [{ key: "client", text: "Client" }],
            edges: [{ from: "client", to: "s1" }],
          })
        ),
        new AIMessage({ content: "Done." }),
      ]),
    })

    // The shape it started with, plus the one it drew.
    expect(result.finalShapes.map((entry) => entry.text)).toEqual([
      "API",
      "Client",
    ])
    expect(result.finalConnections).toHaveLength(1)
  })

  it("records the tool calls and their replies", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([
        callTurn(toolCall("read_board", { scope: "all" })),
        new AIMessage({ content: "One box, labelled API." }),
      ]),
    })

    expect(result.toolCalls.map((call) => call.name)).toEqual(["read_board"])
    expect(result.toolReplies[0]).toContain("API")
  })

  it("keeps the session's correction, which is how idValidity sees an invented id", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([
        callTurn(toolCall("move_shape", { id: "s9", x: 0, y: 0 })),
        new AIMessage({ content: "Could not find it." }),
      ]),
    })

    expect(result.toolReplies.join("\n")).toContain("There is no shape with id")
    expect(result.ops).toEqual([])
  })

  it("takes the last prose message as the reply, not an empty tool-calling one", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([
        callTurn(toolCall("read_board", {})),
        new AIMessage({ content: "There is one box on the board." }),
      ]),
    })

    expect(result.reply).toBe("There is one box on the board.")
  })

  it("counts the model calls the turn actually spent", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([
        callTurn(toolCall("read_board", {})),
        callTurn(toolCall("focus_viewport", {})),
        new AIMessage({ content: "Looking at it." }),
      ]),
    })

    expect(result.llmCalls).toBe(3)
  })

  it("returns a clean, gradeable result for a turn that drew nothing", async () => {
    const result = await runTurn(KASE, {
      model: scriptedModel([new AIMessage({ content: "Nothing to do." })]),
    })

    expect(result.ops).toEqual([])
    expect(result.toolCalls).toEqual([])
    expect(result.reply).toBe("Nothing to do.")
    expect(result.finalShapes).toHaveLength(1)
  })
})
