import { getCurrentTime } from "@workspace/agent-tools/time"
import { webSearch } from "@workspace/agent-tools/web-search"
import { createAgent, type Agent } from "@workspace/agents-core"
import type { StructuredToolInterface } from "@langchain/core/tools"

import type { ExtraToolsAgentOptions } from "./agent-options.ts"

export type CreateAssistantOptions = ExtraToolsAgentOptions

/**
 * What the general assistant carries.
 *
 * ⚠️ **Both entries are module singletons, and that is the whole membership
 * rule.** This used to be `allTools` in `@workspace/agent-tools`, which called
 * itself "every tool in the catalog" and had not been true for a long time:
 * every tool added since is a `createX(catalog, log)` factory bound to one run,
 * which a module-level array structurally cannot hold. Naming the two here
 * makes the list honest and puts it where the decision belongs — which tools an
 * agent carries is the agent's business, and the other agents in this package
 * already choose theirs the same way.
 *
 * Adding to it is a product decision, not a wiring one. In particular a page
 * fetcher must not appear: `extractPage` retrieves an arbitrary URL, and
 * `OVERVIEW.md` sets out why that may not go to a chat agent. `assistant.test.ts`
 * pins the list for that reason.
 */
export const ASSISTANT_TOOLS: readonly StructuredToolInterface[] = [
  getCurrentTime,
  webSearch,
]

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
 * A general-purpose assistant carrying {@link ASSISTANT_TOOLS}.
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
    tools: [...ASSISTANT_TOOLS, ...extraTools],
  })
}
