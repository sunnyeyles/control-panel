/**
 * Reads the OpenAI API key from the environment.
 *
 * Deliberately a function rather than a module-level constant: importing this
 * package must never throw, so the check happens when a model is actually
 * constructed. Builds, typechecks, and consumers that never run the agent do
 * not need `OPENAI_API_KEY` to be set.
 */
export function getOpenAIApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it, or pass `apiKey` to createModel()."
    )
  }

  return apiKey
}
