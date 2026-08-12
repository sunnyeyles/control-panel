import type { Agent } from "@workspace/agents"
import { createLangfuseCallback } from "@workspace/langfuse"

/**
 * One model call from the dashboard, traced, with an answer or a throw. Shared by
 * drafting a Cover Letter, generating a Tailored Resume, and proposing Search
 * Criteria, which each held an identical copy.
 *
 * ⚠️ **Not under `lib/posting-documents/`.** The third caller produces no
 * document; what the three share is how the dashboard talks to an agent.
 *
 * **The callback is not optional decoration.** Every agent run in this repository
 * reports to Langfuse, and each caller here has its own reason a lost transcript
 * hurts: a letter is in the user's own voice, and "did the model invent this
 * employer, or was it in the CV" is answerable from a trace and nowhere else.
 *
 * ⚠️ The shape is `lib/chat-handler.ts`'s: **a handler per invocation** — they
 * retain run state, so sharing one would mix traces — and the callback is spread
 * in only when configured, because `callbacks: [undefined]` is not the same as no
 * callbacks.
 *
 * `.invoke()` and not `.stream()`: none of the three agents carries tools, so
 * each graph is START → model → END with no intermediate steps to stream.
 */
export interface TracedAgentRun {
  /**
   * What this run is, in one hyphenated word.
   *
   * ⚠️ **It is four things at once, and they must not drift apart**: the
   * LangChain `runName`, the Langfuse `feature`, the second trace tag, and the
   * subject of the error thrown when the model answers with nothing. Three
   * copies of this function spelled all four separately, which is a Langfuse
   * view that silently stops matching a run name.
   */
  name: string
  /**
   * The page the user clicked from, for the trace's metadata.
   *
   * Not derivable from {@link name}: a letter and a resume are both generated
   * from `/jobs`, and criteria from `/jobs/schedules`.
   */
  route: string
  /** The session's user. Never a value out of a form. */
  userId: string
  /** The whole of what the model is given, composed by the caller. */
  prompt: string
}

/**
 * Run the agent and return its final message, trimmed.
 *
 * **Throws on an empty answer rather than returning `""`.** Otherwise every
 * caller invents the same check — the letters would save an empty object, and the
 * criteria would propose a search for everything. Each action catches this and
 * turns it into its own sentence.
 */
export async function invokeTracedAgent(
  agent: Agent,
  run: TracedAgentRun
): Promise<string> {
  const sessionId = crypto.randomUUID()

  const callback = createLangfuseCallback({
    userId: run.userId,
    sessionId,
    tags: ["dashboard", run.name],
    traceMetadata: {
      feature: run.name,
      route: run.route,
    },
  })

  const result = await agent.invoke(
    { messages: [{ role: "user", content: run.prompt }] },
    {
      runName: run.name,
      metadata: {
        langfuseUserId: run.userId,
        langfuseSessionId: sessionId,
      },
      ...(callback ? { callbacks: [callback] } : {}),
    }
  )

  const answer = result.messages.at(-1)?.text.trim() ?? ""

  if (answer.length === 0) {
    throw new Error(`The ${run.name} agent returned an empty message.`)
  }

  return answer
}
