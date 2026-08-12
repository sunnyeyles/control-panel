/**
 * Run one whiteboard turn and record everything it did.
 *
 * **The ops have to be collected off the custom stream, not the return value**,
 * and that is not an implementation detail to tidy away. `withOps` in
 * `canvas.ts` flushes the session after every mutation and writes the batch to
 * `config.writer`; a run that is not streaming in `"custom"` mode has no
 * writer, so the flush still happens and the ops are simply dropped. Grading a
 * turn invoked any other way would silently grade an empty op list.
 *
 * That the harness therefore exercises the same wire the browser does is a
 * bonus worth keeping: if the coupling between `agents-core` and the tool
 * runtime ever breaks, every case here goes to zero rather than staying green.
 */

import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import type { CanvasOpEvent } from "@workspace/whiteboard-schema"
import type { ChatModelLike } from "@workspace/agents-core"

import { createWhiteboardAgent } from "../src/whiteboard.ts"
import type { EvalCase, RecordedToolCall, TurnResult } from "./types.ts"

export interface RunTurnOptions {
  /** A fake, for the harness's own tests. Omit to build the real agent. */
  model?: ChatModelLike
  /** Passed through to the run, so a case is findable in Langfuse. */
  callbacks?: Callbacks
}

function textOf(message: BaseMessage): string {
  const { content } = message
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : typeof part === "object" && part && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
    )
    .join("")
}

export async function runTurn(
  kase: EvalCase,
  options: RunTurnOptions = {}
): Promise<TurnResult> {
  const started = Date.now()
  const session = createWhiteboardAgent({
    context: kase.board,
    turnId: `eval-${kase.name}`,
    ...(options.model ? { model: options.model } : {}),
  })

  const stream = await session.agent.stream(
    { messages: [new HumanMessage(kase.prompt)] },
    {
      streamMode: ["values", "messages", "custom"],
      runName: "whiteboard-eval",
      ...(options.callbacks ? { callbacks: options.callbacks } : {}),
    }
  )

  const events: CanvasOpEvent[] = []
  let state: { messages: BaseMessage[]; llmCalls: number } | undefined

  for await (const chunk of stream) {
    const [mode, payload] = chunk as [string, unknown]
    if (mode === "custom") {
      events.push(payload as CanvasOpEvent)
    } else if (mode === "values") {
      state = payload as { messages: BaseMessage[]; llmCalls: number }
    }
  }

  const messages = state?.messages ?? []
  const toolCalls: RecordedToolCall[] = []
  const toolReplies: string[] = []
  let reply = ""

  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        toolCalls.push({
          name: call.name,
          args: (call.args ?? {}) as Record<string, unknown>,
        })
      }
      const text = textOf(message).trim()
      // The last non-empty assistant message is the reply; the ones carrying
      // tool calls are usually empty and are not what the user reads.
      if (text.length > 0) reply = text
    } else if (ToolMessage.isInstance(message)) {
      toolReplies.push(textOf(message))
    }
  }

  return {
    ops: events.flatMap((event) => event.ops),
    toolCalls,
    toolReplies,
    reply,
    llmCalls: state?.llmCalls ?? 0,
    finalShapes: session.board.shapes(),
    finalConnections: session.board.connections(),
    durationMs: Date.now() - started,
  }
}
