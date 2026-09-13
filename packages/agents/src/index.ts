export type { ExtraToolsAgentOptions } from "./agent-options.ts"

export {
  ASSISTANT_SYSTEM_PROMPT,
  createAssistant,
  type CreateAssistantOptions,
} from "./assistant.ts"

export {
  createWhiteboardAgent,
  WHITEBOARD_MAX_LLM_CALLS,
  WHITEBOARD_SYSTEM_PROMPT,
  type CreateWhiteboardAgentOptions,
  type WhiteboardSession,
} from "./whiteboard.ts"

export type { Agent } from "@workspace/agents-core"
