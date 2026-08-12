import { toBaseMessages, toUIMessageStream } from "@ai-sdk/langchain"
import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user"
import { boardContextSchema } from "@workspace/agent-tools/canvas-schema"
import { createWhiteboardAgent as defaultWhiteboardAgent } from "@workspace/agents/whiteboard"
import type { WhiteboardSession } from "@workspace/agents/whiteboard"
import { createLangfuseCallback } from "@workspace/langfuse"
import {
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  type UIMessageChunk,
} from "ai"
import { z } from "zod"

/**
 * The whiteboard turn: messages and a board in, prose and canvas ops out.
 *
 * Deliberately a near-copy of `lib/chat-handler.ts` rather than a generalisation
 * of it: the two differ in the one place that matters, and an abstraction over
 * that would have to be parameterised by both. A third agent route is the moment
 * to reconsider. The differences, each load-bearing:
 *
 * - **The board arrives in the request body, every turn.** The browser owns the
 *   canvas; this handler is told what it looks like and does not remember, which
 *   is what makes drift self-healing and keeps stale snapshots out of history.
 * - **`"custom"` joins the stream modes** — the channel the canvas tools write
 *   ops to. `"values"` and `"messages"` stay first and stay paired.
 * - **The agent is built per request**, because its system prompt contains the
 *   board. Nothing here can be cached between turns, by construction.
 *
 * Nothing here imports Next, which is what lets Vitest cover the authorization
 * and validation branches at all.
 */

/**
 * `"values"` and `"messages"` are the pair `toUIMessageStream()` sniffs for —
 * see the note on `CHAT_STREAM_MODE`, which this extends rather than replaces.
 * `"custom"` is what makes `runtime.writer` exist inside the canvas tools; drop
 * it and every tool still succeeds while the canvas silently never changes.
 */
const WHITEBOARD_STREAM_MODE: ["values", "messages", "custom"] = [
  "values",
  "messages",
  "custom",
]

const STREAM_ERROR_TEXT = "Something went wrong while running the agent."

const requestBodySchema = z.object({
  messages: z.array(z.unknown()),
  board: z.unknown(),
  sessionId: z.string().uuid().optional(),
})

export interface WhiteboardHandlerDeps {
  /** Agent factory — the seam a test fake plugs into. */
  createWhiteboardAgent?: typeof defaultWhiteboardAgent
  /** Who is asking. Lets the handler be exercised without a live session. */
  getUser?: () => Promise<CurrentUser>
}

/** Identical to the chat handler's, and for the same reason: see that note. */
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

export function createWhiteboardHandler(
  deps: WhiteboardHandlerDeps = {}
): (req: Request) => Promise<Response> {
  const createWhiteboardAgent =
    deps.createWhiteboardAgent ?? defaultWhiteboardAgent
  const getUser = deps.getUser ?? getCurrentUser

  return async function POST(req: Request): Promise<Response> {
    // Before anything else, including parsing the body — this route spends the
    // OpenAI budget, and must not be reachable because a proxy matcher was
    // wrong. Same posture and same 401-for-both as `/api/chat`.
    const caller = await requireUser(getUser, "whiteboard")

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

    // The board is validated against the same schema the tools were built
    // from, because both sides import it — a client that starts sending a
    // field this server does not know about is a 400 here rather than an
    // undefined read somewhere inside a layout calculation.
    const board = boardContextSchema.safeParse(parsed.data.board)
    if (!board.success) {
      console.error("whiteboard: invalid board", board.error)
      return Response.json({ error: "Invalid request body" }, { status: 400 })
    }

    const validated = await safeValidateUIMessages({
      messages: parsed.data.messages,
    })
    if (!validated.success) {
      console.error("whiteboard: invalid messages", validated.error)
      return Response.json({ error: "Invalid request body" }, { status: 400 })
    }

    let stream
    try {
      const sessionId = parsed.data.sessionId ?? crypto.randomUUID()
      // The turn id groups this turn's ops into a single undo step in the
      // browser, so it has to be decided here — before any op is written — and
      // travel with every batch.
      const turnId = crypto.randomUUID()
      const session: WhiteboardSession = createWhiteboardAgent({
        context: board.data,
        turnId,
      })
      const callback = createLangfuseCallback({
        userId: caller.userId,
        sessionId,
        tags: ["dashboard", "whiteboard"],
        traceMetadata: {
          feature: "whiteboard",
          route: "/api/whiteboard",
          // Langfuse takes string metadata only; how busy the board was is
          // the first thing worth knowing when a trace looks slow.
          shapes: String(board.data.shapes.length),
        },
      })
      stream = await session.agent.stream(
        { messages: await toBaseMessages(validated.data) },
        {
          streamMode: WHITEBOARD_STREAM_MODE,
          runName: "whiteboard-turn",
          metadata: {
            langfuseUserId: caller.userId,
            langfuseSessionId: sessionId,
          },
          ...(callback ? { callbacks: [callback] } : {}),
        }
      )
    } catch (error) {
      console.error("whiteboard: failed to start agent run", error)
      return Response.json(
        { error: "The agent is unavailable." },
        { status: 500 }
      )
    }

    const uiStream = toUIMessageStream(stream, {
      onError: (error) => console.error("whiteboard: stream error", error),
    })

    return createUIMessageStreamResponse({
      stream: maskErrorChunks(uiStream),
    })
  }
}
