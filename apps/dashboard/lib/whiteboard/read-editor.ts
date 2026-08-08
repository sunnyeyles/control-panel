import type { BoardContext } from "@workspace/agent-tools/canvas-schema"
import type { Editor } from "tldraw"

import { drainRecentEdits } from "./recent-edits"
import { toBoardContext, type BindingLike, type Bounds } from "./simplify"

/**
 * Read the live canvas into the structured board the agent is sent.
 *
 * Split from `simplify.ts` so that module can stay free of tldraw entirely and
 * be unit-tested against plain objects. Everything tldraw-specific — which
 * methods to call, and in what order — is here; everything with a decision in
 * it is there. The `Editor` import is type-only, so this module still adds
 * nothing to the bundle beyond its own code.
 *
 * Called once per turn, at send time rather than on a subscription. The board
 * the agent reasons about must be the board as it was when the user pressed
 * enter, not a snapshot from whenever a render last happened.
 */
export function readBoardContext(
  editor: Editor,
  lastTurnErrors?: string[]
): BoardContext {
  const shapes = editor.getCurrentPageShapes()

  // Page bounds rather than `props.w`/`props.h`: a note has no width of its
  // own, a text shape grows its own height, and a rotated shape occupies a
  // different rectangle from the one its props describe. tldraw already
  // computes this; re-deriving it here would be a second, worse answer.
  const boundsById = new Map<string, Bounds>()
  for (const shape of shapes) {
    const bounds = editor.getShapePageBounds(shape.id)
    if (bounds) {
      boundsById.set(shape.id, {
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        h: bounds.h,
      })
    }
  }

  const bindings: BindingLike[] = editor.store
    .allRecords()
    .filter(
      (record): record is Extract<typeof record, { typeName: "binding" }> =>
        record.typeName === "binding"
    )
    .map((binding) => ({
      id: binding.id,
      type: binding.type,
      fromId: binding.fromId,
      toId: binding.toId,
      props: binding.props as unknown as Record<string, unknown>,
    }))

  const viewport = editor.getViewportPageBounds()

  return toBoardContext({
    shapes: shapes.map((shape) => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      rotation: shape.rotation,
      props: shape.props as Record<string, unknown>,
    })),
    bindings,
    boundsById,
    selection: editor.getSelectedShapeIds(),
    viewport: {
      x: viewport.x,
      y: viewport.y,
      w: viewport.w,
      h: viewport.h,
    },
    // Draining here is what scopes "recent" to one turn: whatever the user did
    // while the last answer was streaming is reported once and then forgotten.
    recentEdits: drainRecentEdits(),
    ...(lastTurnErrors ? { lastTurnErrors } : {}),
  })
}
