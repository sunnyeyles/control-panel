import { ChatOpenAI } from "@langchain/openai"

import { getOpenAIApiKey } from "./env.js"

/** Default chat model. Override per-call via {@link ModelOptions.model}. */
export const DEFAULT_MODEL = "gpt-5.5"

type ChatOpenAIFields = ConstructorParameters<typeof ChatOpenAI>[0]

export interface ModelOptions {
  /** Model id. Defaults to {@link DEFAULT_MODEL}. */
  model?: string
  /**
   * Output cap. Left unset by default — on reasoning-capable models this also
   * covers reasoning tokens, so a tight cap truncates the answer.
   */
  maxTokens?: number
  /** Falls back to `OPENAI_API_KEY`. */
  apiKey?: string
  /** Escape hatch for any other `ChatOpenAI` field. */
  overrides?: ChatOpenAIFields
}

/**
 * Build the chat model the agent runs on.
 *
 * `temperature` is deliberately not set: reasoning-capable models reject any
 * non-default value. Pass it through `overrides` only on a model that takes it.
 */
export function createModel(options: ModelOptions = {}): ChatOpenAI {
  const apiKey = options.apiKey ?? getOpenAIApiKey()

  return new ChatOpenAI({
    model: options.model ?? DEFAULT_MODEL,
    ...(options.maxTokens === undefined
      ? {}
      : { maxTokens: options.maxTokens }),
    apiKey,
    ...options.overrides,
  })
}
