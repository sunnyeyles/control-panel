"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { Tldraw, getSnapshot, loadSnapshot, type Editor } from "tldraw"

import { clearRecentEdits, noteUserEdit } from "@/lib/whiteboard/recent-edits"

import "tldraw/tldraw.css"

/**
 * How long the board must be still before it is written.
 *
 * Long enough that a drag is one save rather than sixty, short enough that a
 * reload a couple of seconds after the last stroke still finds it. The store
 * feed fires on every pointer move, so without a debounce this would be a PUT
 * per frame.
 */
const SAVE_DEBOUNCE_MS = 2000

/**
 * Write the board, and swallow whatever goes wrong.
 *
 * A failed autosave is not the user's problem to solve and there is nothing
 * useful to tell them — they did not ask for this write, and another one
 * follows the next time they touch anything. It is logged so a persistent
 * failure is visible in the console, which is where a client-side fault in this
 * app has to be read from anyway.
 */
async function saveBoard(editor: Editor): Promise<void> {
  try {
    const response = await fetch("/api/whiteboard/board", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot: getSnapshot(editor.store) }),
    })
    if (!response.ok) {
      console.error("whiteboard: save refused", response.status)
    }
  } catch (error) {
    console.error("whiteboard: save failed", error)
  }
}

export interface WhiteboardCanvasProps {
  /** Handed the editor once, on mount, so the chat panel can read and write it. */
  onEditor: (editor: Editor) => void
  /** The user's saved board, or `null` if they have none yet. */
  snapshot: unknown
}

/**
 * The canvas itself.
 *
 * Reached only through `dynamic(..., { ssr: false })` in
 * `whiteboard-workspace.tsx` — tldraw reaches for `window` at import time, so
 * this module must never be evaluated on the server. Nothing else in the app
 * may import it, for the same reason.
 *
 * Beyond rendering it does two things: it hands the `Editor` up so the chat
 * panel can read the board and apply ops to it, and it records which shapes the
 * *user* has touched. That second job has to live here because it needs the
 * store's change feed.
 */
export function WhiteboardCanvas({
  onEditor,
  snapshot,
}: WhiteboardCanvasProps) {
  const { resolvedTheme } = useTheme()
  const editorRef = useRef<Editor | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The same editor as `editorRef`, in state as well, purely so the theme
  // effect below has something to depend on. tldraw builds its editor in a
  // layout effect of a later render, so an effect that only reads the ref runs
  // once against `null` and is never given a reason to run again.
  const [mountedEditor, setMountedEditor] = useState<Editor | null>(null)

  // Frozen at the first render, deliberately. `snapshot` is a fresh object
  // every time the server component re-renders, so depending on it directly
  // would rebuild `handleMount`, remount `<Tldraw>`, and throw away whatever
  // the user had drawn since. There is only ever one board to load, and this is
  // it — later saves flow the other way.
  const [initialSnapshot] = useState(snapshot)

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      setMountedEditor(editor)

      if (initialSnapshot && typeof initialSnapshot === "object") {
        try {
          loadSnapshot(
            editor.store,
            initialSnapshot as Parameters<typeof loadSnapshot>[1]
          )
        } catch (error) {
          // A snapshot tldraw cannot migrate is not worth taking the page down
          // for. The user gets an empty canvas, and the next autosave replaces
          // whatever could not be read.
          console.error("whiteboard: could not load the saved board", error)
        }
      }

      // Loading counts as neither the user's work nor the agent's. Without
      // this every restored shape would be reported as "just drawn" on the
      // first turn after a reload.
      clearRecentEdits()

      onEditor(editor)

      // `source: "user"` excludes changes tldraw itself synthesises, and
      // nothing else: in `@tldraw/store` it means *local*, so the agent's
      // writes through `applyOps` arrive here too. Telling those apart is
      // `recent-edits.ts`'s job, and the reason it cannot be done with the
      // source filter is written up there.
      //
      // `onMount` may return a cleanup function, so the two subscriptions are
      // composed into one and torn down with the editor.
      const stopTracking = editor.store.listen(
        (entry) => {
          for (const record of Object.values(entry.changes.added)) {
            if (record.typeName === "shape") noteUserEdit(record.id)
          }
          for (const [, next] of Object.values(entry.changes.updated)) {
            if (next.typeName === "shape") noteUserEdit(next.id)
          }
        },
        { scope: "document", source: "user" }
      )

      // Autosave listens without a `source` filter, unlike the tracker above:
      // what the agent drew has to be saved too, and only the *attribution*
      // of an edit cares who made it.
      const stopSaving = editor.store.listen(
        () => {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            void saveBoard(editor)
          }, SAVE_DEBOUNCE_MS)
        },
        { scope: "document" }
      )

      return () => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        setMountedEditor(null)
        stopTracking()
        stopSaving()
      }
    },
    [onEditor, initialSnapshot]
  )

  // tldraw keeps its own light/dark preference, which knows nothing about
  // next-themes, and its default is light — so without this a dark-mode user
  // gets a white canvas. Depending on the editor and not only the theme is what
  // makes it fire at all: the editor arrives after this component's first
  // effects have run, and `resolvedTheme` may never change again.
  useEffect(() => {
    if (!mountedEditor || !resolvedTheme) return
    mountedEditor.user.updateUserPreferences({
      colorScheme: resolvedTheme === "dark" ? "dark" : "light",
    })
  }, [mountedEditor, resolvedTheme])

  return (
    <div
      className="h-full w-full"
      // tldraw binds its own single-letter shortcuts — `d` for the draw tool,
      // and a dozen others — which collide with the app's global `d` for dark
      // mode. This attribute tells `theme-provider.tsx` to stand down inside
      // here; see the note there for why it is a marker rather than a
      // stopPropagation, which would take tldraw's own shortcuts with it.
      data-owns-shortcuts=""
    >
      <Tldraw onMount={handleMount} />
    </div>
  )
}
