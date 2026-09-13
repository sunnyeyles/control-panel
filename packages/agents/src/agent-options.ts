import type { AgentTool, CreateAgentOptions } from "@workspace/agents-core"

/**
 * The option shape every factory in this package takes.
 *
 * Both agents here carry their own tools, and a caller may hand either one
 * more without being able to replace what it already has — so `tools` is
 * omitted, and anything extra arrives through `extraTools` and is appended.
 */

/** Options for an agent that carries its own tools and accepts more. */
export interface ExtraToolsAgentOptions extends Omit<
  CreateAgentOptions,
  "tools"
> {
  /** Appended to the tools the agent already carries. */
  extraTools?: AgentTool[]
}
