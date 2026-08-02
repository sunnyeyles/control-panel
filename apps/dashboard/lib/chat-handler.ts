import { toBaseMessages, toUIMessageStream } from "@ai-sdk/langchain"
import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user"
import type { Agent } from "@workspace/agents"
import { createAssistant } from "@workspace/agents/assistant"
import {
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  type UIMessageChunk,
} from "ai"
import { z } from "zod"

/**
 * `@ai-sdk/langchain`'s `toUIMessageStream()` decides it is reading a
 * LangGraph stream by sniffing the first chunk: streaming with an array of
 * modes makes every chunk a `[mode, payload]` tuple, which is what it
 * detects. It then needs `"messages"` events for token streaming and
 * `"values"` events for final state. Change this pair and the UI stream
 * silently degrades — nothing typechecks the coupling.
 */
export const CHAT_STREAM_MODE: ["values", "messages"] = ["values", "messages"]

const STREAM_ERROR_TEXT = "Something went wrong while running the agent."

const requestBodySchema = z.object({ messages: z.array(z.unknown()) })

export interface ChatHandlerDeps {
  /** Agent factory — the seam a test fake plugs into. Defaults to createAssistant. */
  createAgent?: () => Agent
  /**
   * Who is asking. Same seam idea as `createAgent`, and it exists so this
   * handler can be exercised in all three states without a live session.
   */
  getUser?: () => Promise<CurrentUser>
}

/**
 * `toUIMessageStream` catches stream errors internally and enqueues them as
 * `{ type: "error", errorText: error.message }` chunks, so without this the
 * raw server error text would reach the browser.
 */
function maskErrorChunks(
  stream: ReadableStream<UIMessageChunk>
): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        controller.enqueue(
          chunk.type === "error"
            ? { type: "error", errorText: STREAM_ERROR_TEXT }
            : chunk
        )
      },
    })
  )
}

export function createChatHandler(
  deps: ChatHandlerDeps = {}
): (req: Request) => Promise<Response> {
  const createAgent = deps.createAgent ?? (() => createAssistant())
  const getUser = deps.getUser ?? getCurrentUser

  return async function POST(req: Request): Promise<Response> {
    // The authoritative gate. `proxy.ts` also turns anonymous requests away,
    // but this is the check that matters: this route spends the OpenAI budget,
    // and it must not be reachable because a matcher pattern was wrong.
    //
    // Before anything else, including parsing the body — an unauthenticated
    // caller gets no signal about what a well-formed request looks like.
    //
    // "refused" and "anonymous" both answer 401 rather than 403. Distinguishing
    // them here would tell an unapproved caller that their account exists and
    // is merely not on the list, which is more than they need to know; the
    // pages, which have already established who they are, do tell them apart.
    const caller = await requireUser(getUser, "chat")

    if (!caller.ok) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parsed = requestBodySchema.safeParse(body)
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body" }, { status: 400 })
    }

    const validated = await safeValidateUIMessages({
      messages: parsed.data.messages,
    })
    if (!validated.success) {
      console.error("chat: invalid messages", validated.error)
      return Response.json({ error: "Invalid request body" }, { status: 400 })
    }

    let stream
    try {
      const agent = createAgent()
      stream = await agent.stream(
        { messages: await toBaseMessages(validated.data) },
        { streamMode: CHAT_STREAM_MODE }
      )
    } catch (error) {
      console.error("chat: failed to start agent run", error)
      return Response.json(
        { error: "The agent is unavailable." },
        { status: 500 }
      )
    }

    const uiStream = toUIMessageStream(stream, {
      onError: (error) => console.error("chat: stream error", error),
    })

    return createUIMessageStreamResponse({
      stream: maskErrorChunks(uiStream),
    })
  }
}
