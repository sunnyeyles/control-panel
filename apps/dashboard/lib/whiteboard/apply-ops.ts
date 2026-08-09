import {
  Box,
  createShapeId,
  toRichText,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGeoShape,
  type TLNoteShape,
  type TLShapeId,
  type TLTextShape,
} from "tldraw"
import {
  TLDRAW_SHAPE_ID_PREFIX,
  type CanvasOp,
} from "@workspace/agent-tools/canvas-schema"

import { noteAgentEdit } from "./recent-edits"
import { geoValueFor, isGeoKind, shapeTypeFor } from "./shape-kinds"

/**
 * Execute a batch of canvas ops against the live editor.
 *
 * This is the only place in the app that writes to the canvas on the agent's
 * behalf, and it is deliberately dumb: it translates, it does not decide. Every
 * judgement — where a shape goes, whether an id exists, how a row is spaced —
 * was made server-side against the shadow board before the op was written.
 *
 * Being the only such place is also why attribution lives here. tldraw's change
 * feed cannot tell the agent's writes from the user's, so each one is claimed
 * with `noteAgentEdit` on the way past; see `recent-edits.ts` for why that is a
 * claim consumed later rather than a flag held now.
 *
 * **Ops are applied on a best-effort basis and never throw.** The user has been
 * drawing the whole time the agent was thinking, so an op can legitimately
 * arrive for a shape they have just deleted. Skipping it is correct — last
 * write wins, and a missing target means the user's newer intent stands. What
 * failed comes back as prose, which the caller sends up with the *next* turn's
 * board so the model learns what did not land rather than believing it did.
 */

/** A short id (`s7`) is the second half of a tldraw id (`shape:s7`). */
function toShapeId(id: string): TLShapeId {
  return createShapeId(
    id.startsWith(TLDRAW_SHAPE_ID_PREFIX)
      ? id.slice(TLDRAW_SHAPE_ID_PREFIX.length)
      : id
  )
}

export interface ApplyOpsResult {
  /** One line per op that could not be applied. Empty when everything landed. */
  errors: string[]
}

/**
 * @param mark When set, a history stopping point is pushed before the first op
 *   in this batch that changes anything. One ⌘Z then reverts the agent's whole
 *   turn rather than one shape at a time. Pass it on the first batch of a turn
 *   and omit it on the rest.
 *
 *   Known limitation, and an acceptable one: tldraw's history is linear, so a
 *   shape the user drags while the agent is mid-turn lands inside the same
 *   group and is undone along with it.
 */
export function applyOps(
  editor: Editor,
  ops: CanvasOp[],
  mark?: string
): ApplyOpsResult {
  const errors: string[] = []

  if (ops.length === 0) return { errors }

  // One `run` for the whole batch: one render, and — with the mark above — one
  // entry in the undo stack. Applying a twelve-move arrangement op by op would
  // give the user twelve things to undo and eleven intermediate frames.
  editor.run(() => {
    if (mark) editor.markHistoryStoppingPoint(mark)

    for (const op of ops) {
      for (const id of writes(op)) noteAgentEdit(id)

      try {
        applyOne(editor, op)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${describe(op)}: ${message}`)
      }
    }
  })

  return { errors }
}

/**
 * The shape records this op will add or change.
 *
 * Only these need claiming for the agent. A delete shows up in the store feed
 * as a `removed` change and a focus moves the camera, which is instance scope —
 * the tracker in `whiteboard-canvas.tsx` reads neither.
 */
function writes(op: CanvasOp): TLShapeId[] {
  switch (op.op) {
    case "create":
    case "update":
    case "move":
    // The arrow, not its endpoints: binding two shapes does not rewrite them.
    case "connect":
      return [toShapeId(op.id)]
    case "delete":
    case "focus":
      return []
    default: {
      const _exhaustive: never = op
      return _exhaustive
    }
  }
}

function describe(op: CanvasOp): string {
  switch (op.op) {
    case "delete":
      return `deleting ${op.ids.join(", ")}`
    case "focus":
      return "moving the view"
    case "connect":
      return `connecting ${op.fromId} to ${op.toId}`
    default:
      return `${op.op} on ${op.id}`
  }
}

function applyOne(editor: Editor, op: CanvasOp): void {
  switch (op.op) {
    case "create": {
      const id = toShapeId(op.id)
      const type = shapeTypeFor(op.kind)
      const richText = op.text ? { richText: toRichText(op.text) } : {}
      const color = op.color ? { color: op.color } : {}

      if (isGeoKind(op.kind)) {
        editor.createShape<TLGeoShape>({
          id,
          type: "geo",
          x: op.x,
          y: op.y,
          props: {
            geo: geoValueFor(op.kind),
            w: op.w,
            h: op.h,
            ...richText,
            ...color,
          },
        })
        return
      }

      if (type === "note") {
        // A note has no width or height of its own — its size comes from its
        // style and its content — so the op's w/h are dropped here rather than
        // rejected upstream. The model gets a sticky note, which is what it
        // asked for.
        editor.createShape<TLNoteShape>({
          id,
          type: "note",
          x: op.x,
          y: op.y,
          props: { ...richText, ...color },
        })
        return
      }

      // A text shape takes a width and grows its own height, so `autoSize` has
      // to be off for the width to be honoured at all.
      editor.createShape<TLTextShape>({
        id,
        type: "text",
        x: op.x,
        y: op.y,
        props: { w: op.w, autoSize: false, ...richText, ...color },
      })
      return
    }

    case "update": {
      const id = toShapeId(op.id)
      const shape = editor.getShape(id)
      if (!shape) throw new Error("the shape is no longer on the board")

      const props: Record<string, unknown> = {}
      if (op.patch.text !== undefined)
        props.richText = toRichText(op.patch.text)
      if (op.patch.color !== undefined) props.color = op.patch.color
      // A note is the one shape that ignores an explicit size, so writing w/h
      // onto it would be rejected by the schema rather than merely ignored.
      if (shape.type !== "note") {
        if (op.patch.w !== undefined) props.w = op.patch.w
        if (shape.type !== "text" && op.patch.h !== undefined) {
          props.h = op.patch.h
        }
      }

      if (Object.keys(props).length === 0) return
      editor.updateShape({ id, type: shape.type, props })
      return
    }

    case "move": {
      const id = toShapeId(op.id)
      const shape = editor.getShape(id)
      if (!shape) throw new Error("the shape is no longer on the board")

      editor.updateShape({ id, type: shape.type, x: op.x, y: op.y })
      return
    }

    case "delete": {
      // Filter first: `deleteShapes` on an id that no longer exists is not an
      // error worth surfacing — the user got there before the agent did.
      const ids = op.ids.map(toShapeId).filter((id) => editor.getShape(id))
      if (ids.length > 0) editor.deleteShapes(ids)
      return
    }

    case "connect": {
      const fromId = toShapeId(op.fromId)
      const toId = toShapeId(op.toId)
      const from = editor.getShapePageBounds(fromId)
      const to = editor.getShapePageBounds(toId)
      if (!from || !to) {
        throw new Error("one of the shapes is no longer on the board")
      }

      const arrowId = toShapeId(op.id)

      // The arrow sits at the origin so its own `start`/`end` are page
      // coordinates. They are only a starting position: the bindings below
      // take over and recompute both terminals whenever either shape moves,
      // which is the difference between a real connection and a line that
      // happens to be drawn between two boxes.
      editor.createShape<TLArrowShape>({
        id: arrowId,
        type: "arrow",
        x: 0,
        y: 0,
        props: {
          start: { x: from.center.x, y: from.center.y },
          end: { x: to.center.x, y: to.center.y },
          ...(op.label ? { richText: toRichText(op.label) } : {}),
        },
      })

      editor.createBindings<TLArrowBinding>([
        {
          type: "arrow",
          fromId: arrowId,
          toId: fromId,
          props: {
            terminal: "start",
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
          },
        },
        {
          type: "arrow",
          fromId: arrowId,
          toId: toId,
          props: {
            terminal: "end",
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
          },
        },
      ])
      return
    }

    case "focus": {
      const boxes = op.ids
        .map((id) => editor.getShapePageBounds(toShapeId(id)))
        .filter((bounds): bounds is Box => Boolean(bounds))
      if (boxes.length === 0) return

      // There is no zoom-to-shapes helper in tldraw 5; a common box and
      // `zoomToBounds` is the supported route. The padding stops a single
      // shape filling the whole viewport edge to edge.
      const bounds = Box.Common(boxes)
      editor.zoomToBounds(bounds, {
        inset: 120,
        targetZoom: 1,
        animation: { duration: 320 },
      })
      return
    }
  }
}
