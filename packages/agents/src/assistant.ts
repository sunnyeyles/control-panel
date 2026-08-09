import { allTools } from "@workspace/agent-tools"
import { createAgent, type Agent } from "@workspace/agents-core"

import type { ExtraToolsAgentOptions } from "./agent-options.ts"

export type CreateAssistantOptions = ExtraToolsAgentOptions

/**
 * A general-purpose assistant carrying the whole tool catalog.
 *
 * The tool set is the whole of what this factory adds. It states no prompt of
 * its own: an `ASSISTANT_SYSTEM_PROMPT` lived here and was byte-for-byte
 * `DEFAULT_SYSTEM_PROMPT` in `@workspace/agents-core`, so `createAgent`'s own
 * fallback already produced it — two copies of one string, with somewhere for
 * them to drift apart and no consumer importing either. An `options.systemPrompt`
 * still overrides, because it flows through to `createAgent` untouched.
 *
 * A factory rather than a ready-made instance on purpose: building an agent
 * constructs a model, which reads `OPENAI_API_KEY` and throws without one.
 * A module-level instance would move that failure to import time, breaking any
 * consumer that merely imports this module — a Next.js route that is only
 * rendered, say — rather than the one that actually runs the agent.
 */
export function createAssistant(options: CreateAssistantOptions = {}): Agent {
  const { extraTools = [], ...rest } = options

  return createAgent({
    ...rest,
    tools: [...allTools, ...extraTools],
  })
}
