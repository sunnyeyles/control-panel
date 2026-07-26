import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import type { ToolCall } from "@langchain/core/messages/tool"
import {
  END,
  START,
  StateGraph,
  type ConditionalEdgeRouter,
  type GraphNode,
} from "@langchain/langgraph"
import type { ChatOpenAI } from "@langchain/openai"

import { createModel } from "./model.js"
import { AgentState } from "./state.js"
import { createToolRegistry, type AgentTool } from "./tools.js"

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful assistant with access to tools.",
  "Use a tool whenever the answer depends on information you cannot know on your own — the current time, or anything a tool can look up. Do not guess at it.",
  "Lead with the outcome: answer first, supporting detail after.",
].join("\n")

/**
 * Ceiling on model calls per run. Each tool round trip costs one, so this
 * bounds a loop where the model keeps calling tools without converging.
 */
export const DEFAULT_MAX_LLM_CALLS = 10

export interface CreateAgentOptions {
  /** Defaults to {@link createModel}(). */
  model?: ChatOpenAI
  /**
   * Defaults to none — this package ships no tools. Take them from
   * `@workspace/agent-tools`, or pass your own.
   */
  tools?: AgentTool[]
  systemPrompt?: string
  /** Pass a checkpointer (e.g. `new MemorySaver()`) to persist threads. */
  checkpointer?: Parameters<
    StateGraph<typeof AgentState>["compile"]
  >[0] extends { checkpointer?: infer C } | undefined
    ? C
    : never
  maxLlmCalls?: number
}

function toToolMessage(result: unknown, toolCall: ToolCall): ToolMessage {
  if (ToolMessage.isInstance(result)) return result

  return new ToolMessage({
    tool_call_id: toolCall.id ?? "",
    name: toolCall.name,
    content: typeof result === "string" ? result : JSON.stringify(result),
  })
}

function errorToolMessage(toolCall: ToolCall, content: string): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCall.id ?? "",
    name: toolCall.name,
    content,
    status: "error",
  })
}

/**
 * Build and compile the agent graph.
 *
 *     START → model ⇄ tools
 *               ↓
 *              END
 *
 * The model node calls the chat model; the router sends it to the tool node
 * whenever the reply carries tool calls, and the tool node loops back. When the
 * model call budget is exhausted the run is diverted to `halt`, which answers
 * every outstanding tool call with an error so the transcript stays
 * well-formed — an unanswered tool call would be rejected on the next turn.
 */
export function createAgent(options: CreateAgentOptions = {}) {
  const model = options.model ?? createModel()
  const registry = createToolRegistry(options.tools ?? [])
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const maxLlmCalls = options.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS
  const modelWithTools = model.bindTools(registry.tools)

  const callModel: GraphNode<typeof AgentState> = async (state) => {
    const response = await modelWithTools.invoke([
      new SystemMessage(systemPrompt),
      ...state.messages,
    ])

    return { messages: [response], llmCalls: 1 }
  }

  const pendingToolCalls = (state: typeof AgentState.State): ToolCall[] => {
    const last = state.messages.at(-1)
    if (!last || !AIMessage.isInstance(last)) return []
    return last.tool_calls ?? []
  }

  const callTools: GraphNode<typeof AgentState> = async (state) => {
    // Claude emits parallel tool calls; run them concurrently and return every
    // result in one update so each tool_use gets its matching tool_result.
    const messages = await Promise.all(
      pendingToolCalls(state).map(async (toolCall) => {
        const selected = registry.byName[toolCall.name]

        if (!selected) {
          return errorToolMessage(
            toolCall,
            `Unknown tool "${toolCall.name}". Available tools: ${Object.keys(
              registry.byName
            ).join(", ")}.`
          )
        }

        try {
          return toToolMessage(await selected.invoke(toolCall), toolCall)
        } catch (error) {
          return errorToolMessage(
            toolCall,
            `Tool "${toolCall.name}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      })
    )

    return { messages }
  }

  const halt: GraphNode<typeof AgentState> = (state) => ({
    messages: pendingToolCalls(state).map((toolCall) =>
      errorToolMessage(
        toolCall,
        `Stopped: the agent reached its budget of ${maxLlmCalls} model calls before finishing.`
      )
    ),
  })

  const route: ConditionalEdgeRouter<{
    InputSchema: typeof AgentState
    Nodes: "tools" | "halt"
  }> = (state) => {
    if (pendingToolCalls(state).length === 0) return END
    return state.llmCalls >= maxLlmCalls ? "halt" : "tools"
  }

  return new StateGraph(AgentState)
    .addNode("model", callModel)
    .addNode("tools", callTools)
    .addNode("halt", halt)
    .addEdge(START, "model")
    .addConditionalEdges("model", route, ["tools", "halt", END])
    .addEdge("tools", "model")
    .addEdge("halt", END)
    .compile({ checkpointer: options.checkpointer })
}

export type Agent = ReturnType<typeof createAgent>
