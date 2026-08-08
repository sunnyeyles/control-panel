import type {
  BoardConnection,
  BoardContext,
  BoardShape,
  ShapeColor,
  Viewport,
} from "@workspace/agent-tools/canvas-schema"
import { TLDRAW_SHAPE_ID_PREFIX } from "@workspace/agent-tools/canvas-schema"

import { kindForShape } from "./shape-kinds"

/**
 * Turn the live tldraw board into the small structured thing the agent reads.
 *
 * Every import here is type-only, deliberately. tldraw's runtime touches the
 * DOM on import, and this module is the one piece of the client side worth
 * unit-testing — what gets sent up, what gets left out, and where the cap
 * falls. Taking only the shapes of the records means a test can drive it with
 * plain objects and no browser.
 *
 * Two things it is careful about:
 *
 * - **Nothing raw goes up.** A tldraw record carries `props`, `meta`,
 *   `parentId`, `index`, `opacity`, `rotation` and `typeName`; roughly ten
 *   times the bytes, and none of the difference is something the model can act
 *   on. What survives is position, size, label, colour.
 * - **The board is capped, and says so when it is.** Everything outside a
 *   generous margin around the viewport collapses to a count and a bounding
 *   box, which the prompt turns into one line telling the model the board
 *   continues and how to ask for the rest.
 */

/** How far past the viewport a shape still counts as "what the user is doing". */
const VIEWPORT_MARGIN = 0.5

/**
 * The most shapes described in full.
 *
 * A ceiling on the request body rather than a judgement about models: a busy
 * board is thousands of shapes, and a diagram worth reasoning about is tens.
 * `read_board` is how the model gets past this when it genuinely needs to.
 */
export const MAX_DETAILED_SHAPES = 80

/** The slice of a tldraw shape record this module reads. */
export interface ShapeLike {
  id: string
  type: string
  x: number
  y: number
  rotation?: number
  props?: Record<string, unknown>
}

/** The slice of a tldraw binding record this module reads. */
export interface BindingLike {
  id: string
  type: string
  fromId: string
  toId: string
  props?: Record<string, unknown>
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export interface ToBoardContextInput {
  shapes: ShapeLike[]
  bindings: BindingLike[]
  /** Page bounds per shape id — tldraw computes these; we do not re-derive them. */
  boundsById: Map<string, Bounds>
  selection: string[]
  viewport: Viewport
  /** Shape ids the *user* touched since the previous turn. */
  recentEdits?: string[]
  /** Ops the browser could not apply last turn, in prose. */
  lastTurnErrors?: string[]
}

/** `shape:s7` → `s7`. The inverse of what `apply-ops.ts` does. */
export function toSimpleId(id: string): string {
  return id.startsWith(TLDRAW_SHAPE_ID_PREFIX)
    ? id.slice(TLDRAW_SHAPE_ID_PREFIX.length)
    : id
}

function round(value: number): number {
  return Math.round(value)
}

/**
 * Pull the plain string out of tldraw's rich text.
 *
 * `richText` is a ProseMirror document, and the model wants the words. Walking
 * for `text` nodes rather than reaching for a fixed path keeps this working
 * across the shapes that nest differently — a note's paragraph, a geo label, an
 * arrow's label — and degrades to an empty string rather than throwing on a
 * structure it has not seen.
 */
export function plainText(richText: unknown): string {
  const parts: string[] = []

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const record = node as Record<string, unknown>
    if (typeof record.text === "string") parts.push(record.text)
    if (Array.isArray(record.content)) record.content.forEach(walk)
  }

  walk(richText)
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

function colorOf(
  props: Record<string, unknown> | undefined
): ShapeColor | undefined {
  const color = props?.color
  return typeof color === "string" ? (color as ShapeColor) : undefined
}

function intersects(bounds: Bounds, area: Bounds): boolean {
  return (
    bounds.x + bounds.w >= area.x &&
    bounds.x <= area.x + area.w &&
    bounds.y + bounds.h >= area.y &&
    bounds.y <= area.y + area.h
  )
}

function grow(viewport: Viewport, factor: number): Bounds {
  const dx = viewport.w * factor
  const dy = viewport.h * factor
  return {
    x: viewport.x - dx,
    y: viewport.y - dy,
    w: viewport.w + dx * 2,
    h: viewport.h + dy * 2,
  }
}

function union(all: Bounds[]): Bounds {
  const minX = Math.min(...all.map((b) => b.x))
  const minY = Math.min(...all.map((b) => b.y))
  const maxX = Math.max(...all.map((b) => b.x + b.w))
  const maxY = Math.max(...all.map((b) => b.y + b.h))
  return {
    x: round(minX),
    y: round(minY),
    w: round(maxX - minX),
    h: round(maxY - minY),
  }
}

export function toBoardContext(input: ToBoardContextInput): BoardContext {
  const {
    shapes,
    bindings,
    boundsById,
    selection,
    viewport,
    recentEdits = [],
    lastTurnErrors,
  } = input

  // Arrows are reported as connections, never as shapes: an arrow is a
  // relationship, and describing it twice would let the model move one.
  const arrows = new Map<string, ShapeLike>()
  const describable: { shape: ShapeLike; bounds: Bounds }[] = []

  for (const shape of shapes) {
    if (shape.type === "arrow") {
      arrows.set(shape.id, shape)
      continue
    }
    const bounds = boundsById.get(shape.id)
    if (!bounds) continue
    describable.push({ shape, bounds })
  }

  // Near first, so the cap — when it bites — keeps what the user is looking at.
  const area = grow(viewport, VIEWPORT_MARGIN)
  const near = describable.filter((entry) => intersects(entry.bounds, area))
  const far = describable.filter((entry) => !intersects(entry.bounds, area))
  const kept = [...near, ...far].slice(0, MAX_DETAILED_SHAPES)
  const dropped = [...near, ...far].slice(MAX_DETAILED_SHAPES)

  const boardShapes: BoardShape[] = kept.map(({ shape, bounds }) => {
    const color = colorOf(shape.props)
    const text = plainText(shape.props?.richText)
    return {
      id: toSimpleId(shape.id),
      kind: kindForShape(shape.type, shape.props?.geo),
      x: round(bounds.x),
      y: round(bounds.y),
      w: round(bounds.w),
      h: round(bounds.h),
      ...(text ? { text } : {}),
      ...(color ? { color } : {}),
    }
  })

  const visible = new Set(kept.map(({ shape }) => shape.id))

  /**
   * An arrow becomes a connection only when both of its terminals are bound to
   * shapes the model can see.
   *
   * A loose arrow the user dragged between two empty points connects nothing
   * nameable, and reporting it as a connection would be a claim the model would
   * then reason from — "the ingester already talks to the store" — about a
   * relationship that does not exist.
   */
  const connections: BoardConnection[] = []
  for (const [arrowId, arrow] of arrows) {
    const terminals = bindings.filter(
      (binding) => binding.type === "arrow" && binding.fromId === arrowId
    )
    const start = terminals.find((b) => b.props?.terminal === "start")
    const end = terminals.find((b) => b.props?.terminal === "end")
    if (!start || !end) continue
    if (!visible.has(start.toId) || !visible.has(end.toId)) continue

    const label = plainText(arrow.props?.richText)
    connections.push({
      id: toSimpleId(arrowId),
      fromId: toSimpleId(start.toId),
      toId: toSimpleId(end.toId),
      ...(label ? { label } : {}),
    })
  }

  return {
    shapes: boardShapes,
    connections,
    // Both reference lists are narrowed to what was actually described. An id
    // the model is told is selected but never shown is worse than no signal at
    // all: it will act on it, and get a correction back for its trouble.
    selection: selection.filter((id) => visible.has(id)).map(toSimpleId),
    viewport: {
      x: round(viewport.x),
      y: round(viewport.y),
      w: round(viewport.w),
      h: round(viewport.h),
    },
    recentEdits: recentEdits.filter((id) => visible.has(id)).map(toSimpleId),
    ...(dropped.length > 0
      ? {
          offscreen: {
            count: dropped.length,
            bounds: union(dropped.map((entry) => entry.bounds)),
          },
        }
      : {}),
    ...(lastTurnErrors && lastTurnErrors.length > 0 ? { lastTurnErrors } : {}),
  }
}
