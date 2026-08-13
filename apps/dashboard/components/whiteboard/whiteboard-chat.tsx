"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import {
  CANVAS_OP_EVENT,
  canvasOpEventSchema,
  type BoardContext,
  type CanvasOp,
} from "@workspace/whiteboard-schema"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@workspace/ui/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@workspace/ui/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@workspace/ui/components/ai-elements/prompt-input"
import { Shimmer } from "@workspace/ui/components/ai-elements/shimmer"
import {
  Suggestion,
  Suggestions,
} from "@workspace/ui/components/ai-elements/suggestion"
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@workspace/ui/components/ai-elements/tool"
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai"
import { PencilRulerIcon } from "lucide-react"

const SUGGESTIONS = [
  "Draw the architecture for a RAG email system",
  "Clean this diagram up",
  "What is wrong with this architecture?",
]

export interface WhiteboardChatProps {
  /**
   * The board as it stands *now* — called at send time, never at render time,
   * so what goes up is the canvas as the user left it when they pressed enter.
   * `null` when the editor is not mounted.
   */
  readBoard: (lastTurnErrors?: string[]) => BoardContext | null
  /** Apply a batch to the canvas; returns the ops that could not be applied. */
  applyCanvasOps: (ops: CanvasOp[], mark?: string) => string[]
}

/**
 * The conversation beside the canvas.
 *
 * Not `@workspace/ui`'s `AgentChat`, and the difference is not cosmetic. That
 * component sends a fixed body and renders what comes back. This one has to do
 * three things it cannot:
 *
 * - **Send a fresh board with every message.** The board is a snapshot of a
 *   canvas the user is still drawing on, so it has to be read when the message
 *   is sent rather than when the transport was built — see `send`.
 * - **Execute what comes back.** Canvas ops arrive as transient `data-` parts
 *   and are applied to the editor rather than rendered — see `onData`.
 * - **Carry failures forward.** An op that could not be applied is remembered
 *   and sent up with the next turn, which is how the model finds out.
 */
export function WhiteboardChat({
  readBoard,
  applyCanvasOps,
}: WhiteboardChatProps) {
  // Wrapped in an arrow rather than passed as `useState(crypto.randomUUID)`:
  // React calls a lazy initializer bare, which detaches the method from
  // `crypto` and throws "Illegal invocation". Same trap as `agent-chat.tsx`.
  const [sessionId] = useState(() => crypto.randomUUID())

  /**
   * Ops the browser could not apply, held until the next turn.
   *
   * A ref rather than state because nothing renders from it, and because it is
   * written from inside a stream callback where a stale closure over state
   * would silently drop entries.
   */
  const failures = useRef<string[]>([])

  /** Turns whose first op batch has already opened an undo group. */
  const markedTurns = useRef(new Set<string>())

  // Nothing per-request lives on the transport, so it is built once. The board
  // rides on each `sendMessage` instead — see `send` below.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/whiteboard" }),
    []
  )

  const handleData = useCallback(
    (data: unknown) => {
      // Every custom event the agent writes arrives here, so the type is
      // checked before anything is applied. Validating against the same schema
      // the server built the ops from is what makes the contract enforceable
      // rather than merely agreed.
      const part = data as { type?: string; data?: unknown }
      if (part?.type !== `data-${CANVAS_OP_EVENT}`) return

      const event = canvasOpEventSchema.safeParse(part.data)
      if (!event.success) {
        console.error("whiteboard: unrecognised canvas op", event.error)
        return
      }

      // The first batch of a turn opens the undo group; later batches join it,
      // so one ⌘Z reverts everything the agent did in that turn.
      const isFirstBatch = !markedTurns.current.has(event.data.turnId)
      markedTurns.current.add(event.data.turnId)

      failures.current.push(
        ...applyCanvasOps(
          event.data.ops,
          isFirstBatch ? `ai:${event.data.turnId}` : undefined
        )
      )
    },
    [applyCanvasOps]
  )

  const { messages, sendMessage, status, stop } = useChat({
    transport,
    onData: handleData,
  })

  const isEmpty = messages.length === 0

  /**
   * Send one turn, with the board as it stands at this instant.
   *
   * Reading the canvas here rather than when the transport was built is the
   * whole point: the user has been drawing, selecting and moving things the
   * entire time, and what the agent must reason about is the board they are
   * looking at now. Every path that starts a turn goes through this — a
   * suggestion chip as much as the text box — so none of them can forget it.
   */
  const send = (text: string) => {
    const lastTurnErrors = failures.current
    failures.current = []

    void sendMessage(
      { text },
      {
        body: {
          sessionId,
          // An unmounted editor sends `null` rather than an empty board: the
          // handler answers 400, which is right, because telling the agent the
          // canvas is blank would have it confidently redraw one that is not.
          board: readBoard(
            lastTurnErrors.length > 0 ? lastTurnErrors : undefined
          ),
        },
      }
    )
  }

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim()
    if (!text) return
    send(text)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation>
        <ConversationContent>
          {isEmpty ? (
            <ConversationEmptyState
              description="Draw something and ask about it, or describe what you want on the board."
              icon={<PencilRulerIcon className="size-8" />}
              title="Draw together"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) => {
                    const key = `${message.id}-${index}`

                    if (part.type === "text") {
                      return (
                        <MessageResponse key={key}>{part.text}</MessageResponse>
                      )
                    }

                    if (part.type === "dynamic-tool") {
                      return (
                        <Tool key={key}>
                          <ToolHeader
                            state={part.state}
                            toolName={part.toolName}
                            type={part.type}
                          />
                          <ToolContent>
                            <ToolInput input={part.input} />
                            <ToolOutput
                              errorText={part.errorText}
                              output={part.output}
                            />
                          </ToolContent>
                        </Tool>
                      )
                    }

                    if (isToolUIPart(part)) {
                      return (
                        <Tool key={key}>
                          <ToolHeader
                            state={part.state}
                            title={getToolName(part)}
                            type={part.type}
                          />
                          <ToolContent>
                            <ToolInput input={part.input} />
                            <ToolOutput
                              errorText={part.errorText}
                              output={part.output}
                            />
                          </ToolContent>
                        </Tool>
                      )
                    }

                    // Canvas ops are deliberately not rendered: they arrive as
                    // transient data parts, they were applied by `onData`
                    // already, and the user can see the result on the canvas.
                    return null
                  })}
                </MessageContent>
              </Message>
            ))
          )}
          {status === "submitted" && <Shimmer>Thinking…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="grid shrink-0 gap-2 p-4 pt-2">
        {isEmpty && (
          <Suggestions>
            {SUGGESTIONS.map((suggestion) => (
              <Suggestion
                key={suggestion}
                onClick={send}
                suggestion={suggestion}
              />
            ))}
          </Suggestions>
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask for a diagram, or about this one…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit onStop={stop} status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}
