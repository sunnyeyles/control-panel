import type { Agent } from "@workspace/agents"
import { createLangfuseCallback } from "@workspace/langfuse"

/**
 * One model call from the dashboard, traced, with an answer or a throw.
 *
 * ## Why this exists
 *
 * Three actions — drafting a **Cover Letter**, generating a **Tailored
 * Resume**, and proposing **Search Criteria** — each held their own copy of
 * this, and the copies were identical apart from four string literals that were
 * always the same string. {@link TracedAgentRun.name} is that string, said once.
 *
 * ⚠️ **This is not under `lib/posting-documents/`.** The third caller produces
 * no document at all; what the three share is how the dashboard talks to an
 * agent, which is a different thing from what two of them then write.
 *
 * ## Why the callback is not optional decoration
 *
 * Every agent run in this repository reports to Langfuse — `generate-briefing`
 * from the worker, `chat-response` and `whiteboard-turn` from the dashboard — and
 * one that did not would be the only agent invocation whose prompt and output
 * nobody can inspect after the fact. Each caller has its own reason that is the
 * worst place to lose the transcript: a letter is written in the user's own
 * voice, a tailored resume makes factual claims in their name ("did the model
 * invent this employer, or was it in the CV" is answerable from a trace and
 * nowhere else), and criteria come back subtly wrong with the whole CV as the
 * prompt.
 *
 * The shape is `lib/chat-handler.ts`'s: **a handler per invocation** — they
 * retain run state, so sharing one would mix traces — `langfuseUserId` and
 * `langfuseSessionId` in metadata, and the callback spread in only when Langfuse
 * is configured. It is `undefined` without keys, and `callbacks: [undefined]` is
 * not the same as no callbacks.
 *
 * ## Why `.invoke()` and not `.stream()`
 *
 * None of the three agents carries tools, so each graph is START → model → END
 * and there are no intermediate steps for a stream to be interesting about. The
 * `letter` CLI in the worker makes the same call for the same reason.
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
 * **Throws on an empty answer rather than returning `""`.** A model that
 * answered with nothing has told the caller nothing, and every caller would
 * otherwise have to invent the same check — the letters would save an empty
 * object, and the criteria would propose a search for everything. The three
 * actions each catch this and turn it into their own sentence, which is where a
 * user-facing message belongs.
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
