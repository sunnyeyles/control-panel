import { ToolMessage } from "@langchain/core/messages"
import type { ToolCall } from "@langchain/core/messages/tool"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { StructuredToolInterface } from "@langchain/core/tools"

/**
 * The tool shape the graph dispatches. Structurally a plain LangChain tool, so
 * anything built with `tool()` qualifies — `@workspace/agent-tools` supplies
 * the shared catalog without depending on this package.
 */
export type AgentTool = StructuredToolInterface

export interface ToolRegistry {
  /** Passed to `model.bindTools()`. */
  tools: AgentTool[]
  /**
   * Run one tool call; every failure becomes a status:"error" ToolMessage.
   *
   * `config` is the calling graph node's own `RunnableConfig`, and forwarding
   * it is what gives a tool `config.writer` — LangGraph's custom-stream
   * channel. Without it a tool can only reach the caller through its return
   * value, which the model then has to read; with it, a tool can also push
   * events straight onto the run's stream while the turn is still going.
   */
  dispatch(toolCall: ToolCall, config?: RunnableConfig): Promise<ToolMessage>
}

function toToolMessage(result: unknown, toolCall: ToolCall): ToolMessage {
  if (ToolMessage.isInstance(result)) return result

  return new ToolMessage({
    tool_call_id: toolCall.id ?? "",
    name: toolCall.name,
    content: typeof result === "string" ? result : JSON.stringify(result),
  })
}

export function errorToolMessage(
  toolCall: ToolCall,
  content: string
): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCall.id ?? "",
    name: toolCall.name,
    content,
    status: "error",
  })
}

/**
 * Index a tool list by name — rejecting duplicates, which would silently
 * shadow each other — and expose the one operation the graph needs: run a
 * tool call and get back a well-formed ToolMessage, whatever happens.
 * Unknown tools and tool throws come back as status:"error" messages so the
 * run continues and the transcript stays well-formed.
 */
export function createToolRegistry(tools: AgentTool[]): ToolRegistry {
  const byName: Record<string, AgentTool> = {}

  for (const entry of tools) {
    if (byName[entry.name]) {
      throw new Error(`Duplicate tool name in registry: "${entry.name}"`)
    }
    byName[entry.name] = entry
  }

  const dispatch = async (
    toolCall: ToolCall,
    config?: RunnableConfig
  ): Promise<ToolMessage> => {
    const selected = byName[toolCall.name]

    if (!selected) {
      return errorToolMessage(
        toolCall,
        `Unknown tool "${toolCall.name}". Available tools: ${Object.keys(
          byName
        ).join(", ")}.`
      )
    }

    try {
      return toToolMessage(await selected.invoke(toolCall, config), toolCall)
    } catch (error) {
      return errorToolMessage(
        toolCall,
        `Tool "${toolCall.name}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return { tools, dispatch }
}
