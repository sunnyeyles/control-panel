/**
 * Pure layout maths for `arrange_shapes`.
 *
 * Kept out of the session so the switch can grow without the mutator surface,
 * and so a new `Layout` variant fails to compile until a case exists.
 */

import type {
  BoardConnection,
  BoardShape,
  Layout,
} from "@workspace/whiteboard-schema"
import { layerGraph } from "./graph-layout.ts"

/**
 * A flow layout's gap along the arrows, relative to the gap across them.
 *
 * The along axis is the one an arrow crosses, and a labelled arrow needs
 * somewhere to put the label, so it gets half again the breathing room.
 */
const ALONG_GAP_RATIO = 1.5

/** Coordinates are pixels; fractions of one help nobody and bloat every op. */
export function round(value: number): number {
  return Math.round(value)
}

/**
 * Reposition a set of shapes, returning the new top-left of each.
 *
 * Ordering is by current position rather than by the order the model listed
 * the ids, so "arrange these in a row" preserves the arrangement the user can
 * already see instead of reshuffling it to match an argument list.
 *
 * `connections` are only read by `flow-*` layouts; the geometric layouts ignore
 * them.
 */
export function computeLayout(
  subjects: BoardShape[],
  layout: Layout,
  gap: number,
  connections: readonly BoardConnection[]
): Map<string, { x: number; y: number }> {
  const moves = new Map<string, { x: number; y: number }>()
  const byX = [...subjects].sort((a, b) => a.x - b.x || a.y - b.y)
  const byY = [...subjects].sort((a, b) => a.y - b.y || a.x - b.x)
  const minX = Math.min(...subjects.map((s) => s.x))
  const minY = Math.min(...subjects.map((s) => s.y))
  const maxRight = Math.max(...subjects.map((s) => s.x + s.w))
  const maxBottom = Math.max(...subjects.map((s) => s.y + s.h))

  // The two layouts that read the board's arrows rather than only its
  // geometry. Anchored at the selection's existing top-left, because tidying
  // a diagram must not also teleport it somewhere else on the page.
  if (layout === "flow-right" || layout === "flow-down") {
    const within = new Set(subjects.map((shape) => shape.id))
    const placed = layerGraph(
      subjects.map((shape) => ({ key: shape.id, w: shape.w, h: shape.h })),
      connections
        .filter((c) => within.has(c.fromId) && within.has(c.toId))
        .map((c) => ({ from: c.fromId, to: c.toId })),
      {
        direction: layout === "flow-right" ? "right" : "down",
        gapAlong: round(gap * ALONG_GAP_RATIO),
        gapAcross: gap,
      }
    )
    for (const shape of subjects) {
      const at = placed.get(shape.id)
      if (at)
        moves.set(shape.id, { x: round(minX + at.x), y: round(minY + at.y) })
    }
    return moves
  }

  switch (layout) {
    case "row": {
      let cursor = minX
      for (const shape of byX) {
        moves.set(shape.id, { x: round(cursor), y: round(minY) })
        cursor += shape.w + gap
      }
      break
    }
    case "column": {
      let cursor = minY
      for (const shape of byY) {
        moves.set(shape.id, { x: round(minX), y: round(cursor) })
        cursor += shape.h + gap
      }
      break
    }
    case "grid": {
      // A near-square grid on a uniform cell, so rows line up even when the
      // shapes differ in size — a ragged grid reads as an accident.
      const columns = Math.max(1, Math.ceil(Math.sqrt(byX.length)))
      const cellW = Math.max(...subjects.map((s) => s.w)) + gap
      const cellH = Math.max(...subjects.map((s) => s.h)) + gap
      byX.forEach((shape, index) => {
        moves.set(shape.id, {
          x: round(minX + (index % columns) * cellW),
          y: round(minY + Math.floor(index / columns) * cellH),
        })
      })
      break
    }
    case "align-left":
      for (const s of subjects) moves.set(s.id, { x: round(minX), y: s.y })
      break
    case "align-right":
      for (const s of subjects)
        moves.set(s.id, { x: round(maxRight - s.w), y: s.y })
      break
    case "align-top":
      for (const s of subjects) moves.set(s.id, { x: s.x, y: round(minY) })
      break
    case "align-bottom":
      for (const s of subjects)
        moves.set(s.id, { x: s.x, y: round(maxBottom - s.h) })
      break
    case "distribute-horizontal": {
      // Equal gaps between edges, inside the extent the shapes already
      // occupy — distributing is about the space between things, not about
      // widening the span the user chose. Clamped at zero because shapes
      // wider than that span would otherwise walk the layout backwards.
      const span = maxRight - minX
      const used = byX.reduce((total, s) => total + s.w, 0)
      const step = Math.max(0, (span - used) / Math.max(1, byX.length - 1))
      let cursor = minX
      for (const shape of byX) {
        moves.set(shape.id, { x: round(cursor), y: shape.y })
        cursor += shape.w + step
      }
      break
    }
    case "distribute-vertical": {
      const span = maxBottom - minY
      const used = byY.reduce((total, s) => total + s.h, 0)
      const step = Math.max(0, (span - used) / Math.max(1, byY.length - 1))
      let cursor = minY
      for (const shape of byY) {
        moves.set(shape.id, { x: shape.x, y: round(cursor) })
        cursor += shape.h + step
      }
      break
    }
    default: {
      const _exhaustive: never = layout
      throw new Error(`Unhandled layout: ${_exhaustive}`)
    }
  }

  return moves
}
