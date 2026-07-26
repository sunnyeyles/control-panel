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
  /** Lookup used by the tool node to dispatch a tool call. */
  byName: Record<string, AgentTool>
}

/**
 * Index a tool list by name, rejecting duplicates — two tools sharing a name
 * would silently shadow each other at dispatch time.
 */
export function createToolRegistry(tools: AgentTool[]): ToolRegistry {
  const byName: Record<string, AgentTool> = {}

  for (const entry of tools) {
    if (byName[entry.name]) {
      throw new Error(`Duplicate tool name in registry: "${entry.name}"`)
    }
    byName[entry.name] = entry
  }

  return { tools, byName }
}
