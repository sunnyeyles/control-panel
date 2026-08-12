"use client"

import { useCallback, useRef, useState } from "react"
import type { CanvasOp } from "@workspace/whiteboard-schema"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react"
import type { Editor } from "tldraw"

import { applyOps } from "@/lib/whiteboard/apply-ops"
import { readBoardContext } from "@/lib/whiteboard/read-editor"

import { WhiteboardCanvas } from "./whiteboard-canvas"
import { WhiteboardChat } from "./whiteboard-chat"

/**
 * Canvas and conversation, side by side.
 *
 * Everything under here reaches tldraw's runtime — the chat panel as much as
 * the canvas, since it applies ops through it — so this is the module that
 * `whiteboard-workspace.tsx` loads with `ssr: false`. Splitting the two across
 * that boundary would put tldraw back into the server render through the chat
 * panel's import of `apply-ops.ts`.
 *
 * The editor is shared by ref rather than by state. It is created once and
 * never replaced, and it changes identity on nothing, so putting it in state
 * would buy a re-render of both panes in exchange for nothing.
 */
export interface WhiteboardSurfaceProps {
  /** The user's saved board, or `null` if they have none yet. */
  snapshot: unknown
}

export function WhiteboardSurface({ snapshot }: WhiteboardSurfaceProps) {
  const editorRef = useRef<Editor | null>(null)
  const [chatOpen, setChatOpen] = useState(true)

  const handleEditor = useCallback((editor: Editor) => {
    editorRef.current = editor
  }, [])

  /**
   * The two things the chat panel needs from the canvas, as functions.
   *
   * It takes these rather than the editor itself, and the reason is not
   * cosmetic: the panel would otherwise have to read `editorRef.current` while
   * building its transport, which is a ref read during render. Handing over two
   * callbacks keeps the ref reads inside callbacks, where they belong, and
   * states the whole of what the conversation is allowed to do to the board.
   */
  const readBoard = useCallback((lastTurnErrors?: string[]) => {
    const editor = editorRef.current
    return editor ? readBoardContext(editor, lastTurnErrors) : null
  }, [])

  const applyCanvasOps = useCallback((ops: CanvasOp[], mark?: string) => {
    const editor = editorRef.current
    return editor ? applyOps(editor, ops, mark).errors : []
  }, [])

  return (
    <div className="relative flex h-full min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">
        <WhiteboardCanvas onEditor={handleEditor} snapshot={snapshot} />
      </div>

      {/*
        Hidden, never unmounted. The conversation lives in the chat panel's own
        state — the messages, the session id the trace is keyed on, and the ops
        the browser could not apply and still owes the model — so taking it out
        of the tree throws all three away. Hiding it mid-stream would be worse
        still: `onData` goes with it, and every remaining op of that turn is
        dropped while the agent goes on describing what it drew.
      */}
      <aside
        className={cn(
          "flex h-full w-[380px] shrink-0 flex-col border-l bg-background",
          !chatOpen && "hidden"
        )}
        inert={!chatOpen}
      >
        <WhiteboardChat applyCanvasOps={applyCanvasOps} readBoard={readBoard} />
      </aside>

      <Button
        aria-label={chatOpen ? "Hide the assistant" : "Show the assistant"}
        className="absolute top-2 right-2 z-10"
        onClick={() => setChatOpen((open) => !open)}
        size="icon"
        variant="secondary"
      >
        {chatOpen ? (
          <PanelRightCloseIcon className="size-4" />
        ) : (
          <PanelRightOpenIcon className="size-4" />
        )}
      </Button>
    </div>
  )
}
