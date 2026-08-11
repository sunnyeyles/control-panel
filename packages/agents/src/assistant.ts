import { allTools } from "@workspace/agent-tools"
import { createAgent, type Agent } from "@workspace/agents-core"

import type { ExtraToolsAgentOptions } from "./agent-options.ts"

export type CreateAssistantOptions = ExtraToolsAgentOptions

/**
 * Product persona for the general-purpose assistant. Owned here rather than
 * in `@workspace/agents-core`: the runtime's default is sterile on purpose,
 * and "use a tool for the current time" is catalog-aware product copy.
 */
export const ASSISTANT_SYSTEM_PROMPT = [
  "You are a helpful assistant with access to tools.",
  "Use a tool whenever the answer depends on information you cannot know on your own — the current time, or anything a tool can look up. Do not guess at it.",
  "Lead with the outcome: answer first, supporting detail after.",
].join("\n")

/**
 * A general-purpose assistant carrying the whole tool catalog.
 *
 * A factory rather than a ready-made instance on purpose: building an agent
 * constructs a model, which reads `OPENAI_API_KEY` and throws without one.
 * A module-level instance would move that failure to import time, breaking any
 * consumer that merely imports this module — a Next.js route that is only
 * rendered, say — rather than the one that actually runs the agent.
 */
export function createAssistant(options: CreateAssistantOptions = {}): Agent {
  const { extraTools = [], systemPrompt, ...rest } = options

  return createAgent({
    ...rest,
    systemPrompt: systemPrompt ?? ASSISTANT_SYSTEM_PROMPT,
    tools: [...allTools, ...extraTools],
  })
}
