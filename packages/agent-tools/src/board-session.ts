/**
 * The board as the server holds it for exactly one turn.
 *
 * The browser is the source of truth for the canvas; this is a shadow copy,
 * seeded from the snapshot the client sent with the request and thrown away
 * when the turn ends. It exists for one reason: so the fourth tool call in a
 * turn can refer to the shape the first one created, which it could not do if
 * every call had to be answered from a snapshot taken before any of them ran.
 *
 * Because it lives one turn, drift is bounded to one turn and repairs itself —
 * the next request re-seeds from whatever the canvas actually looks like,
 * including whatever the user moved while the agent was talking. That is the
 * whole of the concurrency story, and it is why there is no CRDT here.
 *
 * One session per request, created by whoever builds the tools. A module-level
 * instance would leak one user's board into the next request, which on a warm
 * serverless container is not hypothetical — the same reasoning as
 * `posting-catalog.ts`.
 *
 * **Every mutator returns the string the model will read**, including its
 * failures: `"no shape with id s9"` is a correction the model can act on within
 * the same turn, where a thrown error would end the turn with a tool_result the
 * model can only apologise for. Throwing is reserved for faults no rephrasing
 * fixes, per the convention set in `web-search.ts`.
 */

import {
  DEFAULT_GAP,
  DEFAULT_SHAPE_HEIGHT,
  DEFAULT_SHAPE_WIDTH,
  TLDRAW_SHAPE_ID_PREFIX,
  type BoardConnection,
  type BoardContext,
  type BoardShape,
  type CanvasOp,
  type Layout,
  type ShapeColor,
  type ShapeKind,
} from "./canvas-schema.ts"

/** How many ids a correction lists before it gives up and says "and N more". */
const MAX_IDS_IN_CORRECTION = 20

export interface CreateShapeInput {
  kind: ShapeKind
  x: number
  y: number
  w?: number
  h?: number
  text?: string
  color?: ShapeColor
}

export interface UpdateShapeInput {
  id: string
  text?: string
  color?: ShapeColor
  w?: number
  h?: number
}

export interface ArrangeShapesInput {
  ids: string[]
  layout: Layout
  gap?: number
}

export interface BoardSession {
  /** The shadow board as it now stands, in creation order. */
  shapes(): BoardShape[]
  connections(): BoardConnection[]
  /** The snapshot the turn started from — selection, viewport, recent edits. */
  readonly context: BoardContext
  /**
   * Ops recorded since the last flush, cleared by the call.
   *
   * The caller flushes once per tool call and writes the batch to the run's
   * stream. Batching is not an optimisation: a dozen moves from one
   * `arrange_shapes` have to reach the browser together so they apply in a
   * single `editor.run()` — one render, and one entry to undo.
   */
  flush(): CanvasOp[]

  createShape(input: CreateShapeInput): string
  updateShape(input: UpdateShapeInput): string
  moveShape(input: { id: string; x: number; y: number }): string
  deleteShapes(ids: string[]): string
  connectShapes(input: { fromId: string; toId: string; label?: string }): string
  arrangeShapes(input: ArrangeShapesInput): string
  focusViewport(ids?: string[]): string
}

/**
 * Accept `shape:s7` as well as `s7`.
 *
 * The model is shown short ids, but it also sees tldraw-shaped ones whenever a
 * client error quotes one back, and copying the longer form is a transcription
 * habit rather than a claim about a different shape. Forgiven for the same
 * reason `posting-catalog.ts` forgives `[7f3a91c2]`; everything substantive —
 * an id naming no shape — still fails to resolve.
 */
function normaliseId(id: string): string {
  const trimmed = id.trim()
  return trimmed.startsWith(TLDRAW_SHAPE_ID_PREFIX)
    ? trimmed.slice(TLDRAW_SHAPE_ID_PREFIX.length)
    : trimmed
}

function listIds(ids: string[]): string {
  if (ids.length === 0) return "The board is empty."
  const shown = ids.slice(0, MAX_IDS_IN_CORRECTION)
  const rest = ids.length - shown.length
  return `The board has ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`
}

/** Coordinates are pixels; fractions of one help nobody and bloat every op. */
function round(value: number): number {
  return Math.round(value)
}

export function createBoardSession(context: BoardContext): BoardSession {
  const shapes = new Map<string, BoardShape>(
    context.shapes.map((shape) => [shape.id, { ...shape }])
  )
  const connections: BoardConnection[] = context.connections.map((c) => ({
    ...c,
  }))
  let pending: CanvasOp[] = []

  /**
   * `s1`, `s2`, … skipping anything the snapshot already uses.
   *
   * Reading the live snapshot rather than counting from zero is what makes the
   * numbering self-heal: a shape the user deleted between turns frees its name,
   * and a shape they kept keeps it. Arrows share the counter because a tldraw
   * arrow is itself a shape, so the two cannot be allowed to collide.
   *
   * `knownIds` is why the two visible collections are not enough. Both are
   * filtered before they get here — by the viewport cap, and by the rule that
   * an arrow is only a connection when both its terminals are bound — so an id
   * can be absent from this session and present on the canvas. Allocating it
   * would reach `store.put` on the client, which overwrites the user's shape
   * rather than refusing.
   */
  const knownIds = new Set(context.knownIds ?? [])
  let nextId = 1
  const allocateId = (): string => {
    let candidate = `s${nextId}`
    while (
      shapes.has(candidate) ||
      knownIds.has(candidate) ||
      connections.some((c) => c.id === candidate)
    ) {
      nextId += 1
      candidate = `s${nextId}`
    }
    nextId += 1
    return candidate
  }

  const emit = (...ops: CanvasOp[]): void => {
    pending.push(...ops)
  }

  /** Resolve an id, or produce the correction to hand back to the model. */
  const resolve = (
    rawId: string
  ): { shape: BoardShape } | { correction: string } => {
    const id = normaliseId(rawId)
    const shape = shapes.get(id)
    if (shape) return { shape }
    return {
      correction: `There is no shape with id "${rawId}". ${listIds([...shapes.keys()])}`,
    }
  }

  const describe = (shape: BoardShape): string =>
    `${shape.id} (${shape.kind}${shape.text ? ` "${shape.text}"` : ""}) at (${shape.x}, ${shape.y}) ${shape.w}x${shape.h}`

  /**
   * Reposition a set of shapes, returning the new top-left of each.
   *
   * Ordering is by current position rather than by the order the model listed
   * the ids, so "arrange these in a row" preserves the arrangement the user can
   * already see instead of reshuffling it to match an argument list.
   */
  const computeLayout = (
    subjects: BoardShape[],
    layout: Layout,
    gap: number
  ): Map<string, { x: number; y: number }> => {
    const moves = new Map<string, { x: number; y: number }>()
    const byX = [...subjects].sort((a, b) => a.x - b.x || a.y - b.y)
    const byY = [...subjects].sort((a, b) => a.y - b.y || a.x - b.x)
    const minX = Math.min(...subjects.map((s) => s.x))
    const minY = Math.min(...subjects.map((s) => s.y))
    const maxRight = Math.max(...subjects.map((s) => s.x + s.w))
    const maxBottom = Math.max(...subjects.map((s) => s.y + s.h))

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
    }

    return moves
  }

  return {
    context,
    shapes: () => [...shapes.values()],
    connections: () => [...connections],

    flush() {
      const batch = pending
      pending = []
      return batch
    },

    createShape(input) {
      const id = allocateId()
      const shape: BoardShape = {
        id,
        kind: input.kind,
        x: round(input.x),
        y: round(input.y),
        w: round(input.w ?? DEFAULT_SHAPE_WIDTH),
        h: round(input.h ?? DEFAULT_SHAPE_HEIGHT),
        ...(input.text ? { text: input.text } : {}),
        ...(input.color ? { color: input.color } : {}),
      }
      shapes.set(id, shape)
      emit({ op: "create", ...shape })
      return `Created ${describe(shape)}.`
    },

    updateShape(input) {
      const found = resolve(input.id)
      if ("correction" in found) return found.correction

      const patch = {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.w !== undefined ? { w: round(input.w) } : {}),
        ...(input.h !== undefined ? { h: round(input.h) } : {}),
      }
      if (Object.keys(patch).length === 0) {
        return `Nothing to change on ${found.shape.id} — pass at least one of text, color, w or h.`
      }

      Object.assign(found.shape, patch)
      emit({ op: "update", id: found.shape.id, patch })
      return `Updated ${describe(found.shape)}.`
    },

    moveShape(input) {
      const found = resolve(input.id)
      if ("correction" in found) return found.correction

      found.shape.x = round(input.x)
      found.shape.y = round(input.y)
      emit({
        op: "move",
        id: found.shape.id,
        x: found.shape.x,
        y: found.shape.y,
      })
      return `Moved ${describe(found.shape)}.`
    },

    deleteShapes(ids) {
      const removed: string[] = []
      const missing: string[] = []

      for (const rawId of ids) {
        const id = normaliseId(rawId)
        if (shapes.delete(id)) {
          removed.push(id)
          // An arrow whose endpoint is gone is not a connection any more, and
          // tldraw will drop it on the client too; keeping it in the shadow
          // would have the model reasoning about a link that no longer exists.
          for (let i = connections.length - 1; i >= 0; i -= 1) {
            const connection = connections[i]
            if (
              connection &&
              (connection.fromId === id || connection.toId === id)
            ) {
              connections.splice(i, 1)
            }
          }
          continue
        }

        // An arrow id is not in `shapes`, but it *is* an id the model was
        // given, so failing to resolve it would be a correction it cannot act
        // on. To tldraw an arrow is a shape like any other, so the delete op
        // below carries it unchanged.
        const arrowAt = connections.findIndex(
          (connection) => connection.id === id
        )
        if (arrowAt >= 0) {
          connections.splice(arrowAt, 1)
          removed.push(id)
        } else {
          missing.push(rawId)
        }
      }

      if (removed.length > 0) emit({ op: "delete", ids: removed })

      if (removed.length === 0) {
        return `Deleted nothing. ${listIds([
          ...shapes.keys(),
          ...connections.map((connection) => connection.id),
        ])}`
      }
      return missing.length === 0
        ? `Deleted ${removed.join(", ")}.`
        : `Deleted ${removed.join(", ")}. No shape matched ${missing.join(", ")}.`
    },

    connectShapes(input) {
      const from = resolve(input.fromId)
      if ("correction" in from) return from.correction
      const to = resolve(input.toId)
      if ("correction" in to) return to.correction
      if (from.shape.id === to.shape.id) {
        return `Cannot connect ${from.shape.id} to itself.`
      }

      const id = allocateId()
      const connection: BoardConnection = {
        id,
        fromId: from.shape.id,
        toId: to.shape.id,
        ...(input.label ? { label: input.label } : {}),
      }
      connections.push(connection)
      emit({ op: "connect", ...connection })
      return `Connected ${from.shape.id} to ${to.shape.id}${input.label ? ` labelled "${input.label}"` : ""} (arrow ${id}).`
    },

    arrangeShapes(input) {
      const subjects: BoardShape[] = []
      const missing: string[] = []
      for (const rawId of input.ids) {
        const shape = shapes.get(normaliseId(rawId))
        if (shape) subjects.push(shape)
        else missing.push(rawId)
      }

      if (subjects.length < 2) {
        return `Arranging needs at least two shapes that exist. ${listIds([...shapes.keys()])}`
      }
      if (
        subjects.length < 3 &&
        (input.layout === "distribute-horizontal" ||
          input.layout === "distribute-vertical")
      ) {
        return "Distributing needs at least three shapes — with two there is no space between them to even out."
      }

      const gap = Math.max(0, round(input.gap ?? DEFAULT_GAP))
      const moves = computeLayout(subjects, input.layout, gap)

      const ops: CanvasOp[] = []
      for (const shape of subjects) {
        const target = moves.get(shape.id)
        if (!target || (target.x === shape.x && target.y === shape.y)) continue
        shape.x = target.x
        shape.y = target.y
        ops.push({ op: "move", id: shape.id, x: target.x, y: target.y })
      }
      if (ops.length > 0) emit(...ops)

      const note =
        missing.length > 0 ? ` No shape matched ${missing.join(", ")}.` : ""
      return ops.length === 0
        ? `Those ${subjects.length} shapes are already arranged as ${input.layout}.${note}`
        : `Arranged ${ops.length} shape(s) as ${input.layout} with a gap of ${gap}.${note}`
    },

    focusViewport(ids) {
      const targets =
        ids && ids.length > 0
          ? ids.map(normaliseId).filter((id) => shapes.has(id))
          : [...shapes.keys()]

      if (targets.length === 0) {
        return `Nothing to focus on. ${listIds([...shapes.keys()])}`
      }

      emit({ op: "focus", ids: targets })
      return `Moved the view to fit ${targets.length} shape(s).`
    },
  }
}
