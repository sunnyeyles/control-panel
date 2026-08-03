import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"

import type { TraceAgent, TraceToolCall, Tracer } from "./trace.ts"

/**
 * Drive one agent, watching it work.
 *
 * The whole reason this file exists is the difference between `.invoke()` and
 * `.stream()`. `.invoke()` runs the graph to completion and hands back the
 * final state, discarding every intermediate step — the queries the scout tried,
 * what came back, how many turns it burned getting there. `.stream()` yields the
 * same run one superstep at a time, so the transcript can be observed as it
 * happens and the final state is still returned unchanged.
 *
 * That is the entire change. The agents, the graph, and `@workspace/agents-core`
 * are untouched: this is a different way of *reading* the same run.
 */

/**
 * The slice of a compiled agent a run actually drives.
 *
 * Structural on purpose, exactly like `ChatModelLike` in
 * `@workspace/agents-core` and for the same reason — a compiled LangGraph agent
 * satisfies it, and so does a hand-rolled fake, which is what lets a run be
 * exercised with no provider key and no network. Narrow to one method, because
 * one method is all this file calls.
 */
export interface AgentLike {
  stream(
    input: { messages: BaseMessage[] },
    options: AgentStreamOptions
  ): Promise<AsyncIterable<unknown>>
}

export type AgentStreamOptions = Pick<
  RunnableConfig,
  "callbacks" | "metadata" | "runName" | "tags"
> & {
  streamMode: ["updates", "values"]
}

/** Exactly what `.invoke()` used to return, so call sites did not have to change. */
export interface AgentOutcome {
  messages: BaseMessage[]
  llmCalls: number
}

/**
 * Both stream modes at once, and neither is redundant.
 *
 * `updates` carries only what a node just returned, which is what makes an
 * event emittable the moment it happens. `values` carries the whole state after
 * each superstep, so the final chunk *is* the final state — reducers already
 * applied by LangGraph rather than re-implemented here. Accumulating messages
 * by hand from `updates` alone would mean this file quietly owning a copy of
 * `AgentState`'s reducer semantics, and drifting the day one changes.
 */
const STREAM_MODES: ["updates", "values"] = ["updates", "values"]

export async function runAgent(
  agent: AgentLike,
  agentName: TraceAgent,
  input: { messages: BaseMessage[] },
  trace: Tracer,
  options: Omit<AgentStreamOptions, "streamMode"> = {}
): Promise<AgentOutcome> {
  // A tool result names only the call id it answers, so the arguments the model
  // passed live on the AI message one superstep earlier. Correlated here rather
  // than left to the reader: "seek_search returned nothing" is not a useful line
  // without the query next to it.
  const argsByCallId = new Map<string, unknown>()
  let final: AgentOutcome | undefined

  const stream = await agent.stream(input, {
    ...options,
    streamMode: STREAM_MODES,
  })

  for await (const chunk of stream) {
    const parsed = readChunk(chunk)
    if (!parsed) continue

    if (parsed.mode === "values") {
      final = readState(parsed.payload) ?? final
      continue
    }

    // `updates` is keyed by node name — `model`, `tools`, `halt`. The name is
    // deliberately not switched on: what an event is depends on the *message
    // type*, and a node renamed in the graph should not silently stop tracing.
    for (const update of Object.values(asRecord(parsed.payload) ?? {})) {
      for (const message of readState(update)?.messages ?? []) {
        emitFor(message, agentName, argsByCallId, trace)
      }
    }
  }

  if (!final) {
    throw new Error(
      `The ${agentName} produced no state while streaming, so there is nothing to read its answer from. The graph ended without emitting a value.`
    )
  }

  return final
}

function emitFor(
  message: BaseMessage,
  agent: TraceAgent,
  argsByCallId: Map<string, unknown>,
  trace: Tracer
): void {
  if (AIMessage.isInstance(message)) {
    const toolCalls: TraceToolCall[] = (message.tool_calls ?? []).map(
      (call) => {
        if (call.id) argsByCallId.set(call.id, call.args)
        return { name: call.name, args: call.args }
      }
    )

    trace({ type: "message", agent, text: message.text, toolCalls })
    return
  }

  if (ToolMessage.isInstance(message)) {
    trace({
      type: "tool",
      agent,
      name: message.name ?? "(unnamed tool)",
      args: argsByCallId.get(message.tool_call_id) ?? {},
      result:
        typeof message.content === "string" ? message.content : message.text,
      // The `halt` node answers outstanding calls with an error result, so this
      // is also what distinguishes "the search failed" from "the agent ran out
      // of turns before it could search".
      ok: message.status !== "error",
    })
  }
}

/** `[mode, payload]`, which is the shape LangGraph yields for multiple modes. */
function readChunk(
  chunk: unknown
): { mode: string; payload: unknown } | undefined {
  if (!Array.isArray(chunk) || chunk.length < 2) return undefined

  const [mode, payload] = chunk
  return typeof mode === "string" ? { mode, payload } : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Narrow a state value or a node update to the two fields a run reads.
 *
 * Both carry the same field names — an update is a partial state — so one
 * reader serves both. Defensive rather than cast: the stream is typed `any` at
 * its source, and this is the boundary where that stops being true.
 */
function readState(value: unknown): AgentOutcome | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const { messages, llmCalls } = record

  return {
    messages: Array.isArray(messages) ? (messages as BaseMessage[]) : [],
    llmCalls: typeof llmCalls === "number" ? llmCalls : 0,
  }
}
