import {
  createAgent,
  type Agent,
  type AgentTool,
  type CreateAgentOptions,
} from "@workspace/agents-core"

/**
 * The two option shapes every factory in this package takes, and the one
 * mechanism the tool-less ones share.
 *
 * Four agents here — the brief writer, the cover-letter writer, the resume
 * tailor and the profile extractor — are deliberately tool-free, and each used
 * to spell out the same four lines: omit `tools` from the type, default the
 * system prompt, spread the rest, pass `tools: []` last. Four copies of a
 * security mechanism is four places for it to drift, and four test suites
 * proving the same property. One implementation means the property is proven
 * once, in `agent-options.test.ts`, and holds for every factory built from it.
 */

/** Options for an agent whose tool set is fixed at none. */
export type ToollessAgentOptions = Omit<CreateAgentOptions, "tools">

/** Options for an agent that carries its own tools and accepts more. */
export interface ExtraToolsAgentOptions extends Omit<
  CreateAgentOptions,
  "tools"
> {
  /** Appended to the tools the agent already carries. */
  extraTools?: AgentTool[]
}

/**
 * Build a factory for an agent that can call no tools at all.
 *
 * `tools: []` after the spread is the containment, not a style choice: the
 * option type already omits `tools`, and passing the empty set *last* is what
 * keeps a caller who forces one past the compiler from arming the agent
 * anyway. Each agent's module documents why *it* must stay tool-free — the
 * argument is per-agent; the mechanism is this one.
 */
export function defineToollessAgent(
  defaultSystemPrompt: string
): (options?: ToollessAgentOptions) => Agent {
  return function createToollessAgent(
    options: ToollessAgentOptions = {}
  ): Agent {
    const { systemPrompt = defaultSystemPrompt, ...rest } = options

    return createAgent({ ...rest, systemPrompt, tools: [] })
  }
}
