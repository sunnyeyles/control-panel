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
import {
  boundsOf,
  findFreeOrigin,
  layerGraph,
  overlaps,
  PLACEMENT_GAP,
  type FlowDirection,
  type LayoutBox,
} from "./graph-layout.ts"

/** How many ids a correction lists before it gives up and says "and N more". */
const MAX_IDS_IN_CORRECTION = 20

/**
 * A flow layout's gap along the arrows, relative to the gap across them.
 *
 * The along axis is the one an arrow crosses, and a labelled arrow needs
 * somewhere to put the label, so it gets half again the breathing room.
 */
const ALONG_GAP_RATIO = 1.5

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

/**
 * One box in a diagram, as the model describes it: a name to refer to it by, a
 * label to put in it, and nothing about where it goes.
 *
 * `key` is the model's own word — "api", "postgres" — and exists only so the
 * edges have something to name before any id has been allocated. It never
 * reaches the canvas.
 */
export interface DiagramNodeInput {
  key: string
  text: string
  kind?: ShapeKind
  color?: ShapeColor
  w?: number
  h?: number
}

/** An arrow. Endpoints are node keys, or the ids of shapes already on the board. */
export interface DiagramEdgeInput {
  from: string
  to: string
  label?: string
}

export interface DrawDiagramInput {
  nodes: DiagramNodeInput[]
  edges?: DiagramEdgeInput[]
  direction?: FlowDirection
  /** Top-left of the whole block. Omit it and free space is chosen. */
  x?: number
  y?: number
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
  /**
   * Create a whole diagram — boxes and the arrows between them — from a
   * description that carries no coordinates at all. See the method.
   */
  drawDiagram(input: DrawDiagramInput): string
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
   * Which shapes this one is sitting on top of.
   *
   * Reported rather than prevented, which is this module's standing bargain
   * with the model: state what happened, including what went wrong, and let it
   * decide. Refusing the create would be worse — the model would have no shape
   * and no way to see why, where a note names the obstacle and the two tools
   * that fix it.
   *
   * `text` is exempt at both ends. A bare caption laid over a diagram is a
   * caption, not a collision, and flagging it would train the model out of the
   * one kind it should be layering.
   */
  const collidingWith = (subject: BoardShape): string[] => {
    if (subject.kind === "text") return []
    return [...shapes.values()]
      .filter(
        (other) =>
          other.id !== subject.id &&
          other.kind !== "text" &&
          overlaps(subject, other)
      )
      .map((other) => other.id)
  }

  /**
   * `"s1 and s2"` for every overlap a subject is part of. Empty when clean.
   *
   * Against the whole board, not just the subjects: a layout that tidies three
   * shapes onto a fourth it was never asked about has still buried it, and the
   * point of reporting is to say so.
   */
  const overlappingPairs = (subjects: BoardShape[]): string[] => {
    const pairs = new Set<string>()
    for (const subject of subjects) {
      for (const other of collidingWith(subject)) {
        pairs.add([subject.id, other].sort().join(" and "))
      }
    }
    return [...pairs]
  }

  /**
   * Put a shape on the shadow board and record the op.
   *
   * Split out from `createShape` because `drawDiagram` needs the shape itself —
   * it has a dozen to place and an arrow list to resolve against them, and the
   * prose `createShape` returns is written for a model reading one result.
   */
  const addShape = (input: CreateShapeInput): BoardShape => {
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
    return shape
  }

  /** As {@link addShape}, for an arrow. Both terminals must already resolve. */
  const addConnection = (
    fromId: string,
    toId: string,
    label?: string
  ): BoardConnection => {
    const connection: BoardConnection = {
      id: allocateId(),
      fromId,
      toId,
      ...(label ? { label } : {}),
    }
    connections.push(connection)
    emit({ op: "connect", ...connection })
    return connection
  }

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
    }

    return moves
  }

  /**
   * Where a new diagram's top-left corner goes.
   *
   * Three answers, in order. An explicit position wins, because a caller that
   * worked one out had a reason. Otherwise, if the diagram attaches to shapes
   * already on the board, it lands just below them — an extension that appears
   * next to what it extends reads as connected, where one placed across the
   * page reads as a second, unrelated drawing. Failing both, free space near
   * what the user is looking at.
   *
   * What it never does is land on existing work. That is the one outcome that
   * destroys something, and it is the reason this is not simply the viewport
   * centre.
   */
  const resolveOrigin = (
    input: DrawDiagramInput,
    block: LayoutBox,
    existing: BoardShape[],
    edges: DiagramEdgeInput[],
    newKeys: Set<string>
  ): { x: number; y: number } => {
    if (input.x !== undefined && input.y !== undefined) {
      return { x: round(input.x), y: round(input.y) }
    }

    const anchors = new Set<string>()
    for (const edge of edges) {
      for (const raw of [edge.from, edge.to]) {
        if (newKeys.has(raw.trim())) continue
        const id = normaliseId(raw)
        if (shapes.has(id)) anchors.add(id)
      }
    }

    const anchored = boundsOf(existing.filter((shape) => anchors.has(shape.id)))
    if (anchored) {
      const below = {
        x: round(anchored.x),
        y: round(anchored.y + anchored.h + PLACEMENT_GAP),
      }
      const clear = existing.every(
        (shape) => !overlaps({ ...below, w: block.w, h: block.h }, shape)
      )
      if (clear) return below
    }

    return findFreeOrigin(existing, block.w, block.h, context.viewport)
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
      const shape = addShape(input)
      const clash = collidingWith(shape)
      if (clash.length === 0) return `Created ${describe(shape)}.`

      return `Created ${describe(shape)}. It overlaps ${clash.join(", ")} — move it, or draw the whole group with draw_diagram, which works the positions out for you.`
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

      const clash = collidingWith(found.shape)
      if (clash.length === 0) return `Moved ${describe(found.shape)}.`

      return `Moved ${describe(found.shape)}. It now overlaps ${clash.join(", ")} — move it somewhere clear, or arrange the group instead.`
    },

    deleteShapes(ids) {
      const removed: string[] = []
      const missing: string[] = []
      // Deduped on the normalised id: the same shape named twice — or once
      // bare and once bracketed — must not come back as one deletion *and*
      // one "No shape matched", a self-contradicting correction.
      const seen = new Set<string>()

      for (const rawId of ids) {
        const id = normaliseId(rawId)
        if (seen.has(id)) continue
        seen.add(id)
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

      const connection = addConnection(from.shape.id, to.shape.id, input.label)
      return `Connected ${from.shape.id} to ${to.shape.id}${input.label ? ` labelled "${input.label}"` : ""} (arrow ${connection.id}).`
    },

    arrangeShapes(input) {
      const subjects: BoardShape[] = []
      const missing: string[] = []
      // Deduped on the normalised id, because the guards below count
      // *shapes*: `ids: ["s1", "s1"]` is one shape, not the two that
      // arranging needs, and a repeated id must not inflate the count a
      // distribute layout divides space by.
      const seen = new Set<string>()
      for (const rawId of input.ids) {
        const id = normaliseId(rawId)
        if (seen.has(id)) continue
        seen.add(id)
        const shape = shapes.get(id)
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

      // `align-*` and `distribute-*` move along one axis and leave the other
      // alone, so either can finish with two shapes on top of each other and be
      // exactly what was asked for. Saying so is the difference between the
      // model noticing and the user finding it.
      const left = overlappingPairs(subjects)
      const clash =
        left.length > 0
          ? ` ${left.join(", ")} now overlap — move one, or lay the group out with flow-right, flow-down, row, column or grid.`
          : ""

      return ops.length === 0
        ? `Those ${subjects.length} shapes are already arranged as ${input.layout}.${note}${clash}`
        : `Arranged ${ops.length} shape(s) as ${input.layout} with a gap of ${gap}.${note}${clash}`
    },

    /**
     * A whole diagram in one call, from a description with no coordinates.
     *
     * This is the method the rest of the file exists to make possible, and the
     * answer to the agent's oldest weakness: drawing eight boxes and ten arrows
     * used to be eighteen model round trips of arithmetic the model is bad at
     * and cannot see the result of. Here it names the boxes and the arrows,
     * `graph-layout.ts` ranks them by those arrows, and every position is
     * computed against the real board.
     *
     * **Edges may name a shape already on the canvas.** That is what makes
     * "add a cache between the API and the database" a single call: the cache
     * is a new node, and both its arrows land on ids the board already had.
     * Existing shapes are never *moved* by this — a diagram appearing is not a
     * licence to rearrange the user's work — so the new block is placed clear
     * of everything, preferring just below whatever it was anchored to.
     */
    drawDiagram(input) {
      const seen = new Set<string>()
      const nodes: DiagramNodeInput[] = []
      for (const node of input.nodes) {
        const key = node.key.trim()
        if (key.length === 0 || seen.has(key)) continue
        seen.add(key)
        nodes.push({ ...node, key })
      }

      if (nodes.length === 0) {
        return "draw_diagram needs at least one node, each with a key and a label."
      }

      const edges = input.edges ?? []
      const direction: FlowDirection = input.direction ?? "right"

      const placed = layerGraph(
        nodes.map((node) => ({
          key: node.key,
          w: round(node.w ?? DEFAULT_SHAPE_WIDTH),
          h: round(node.h ?? DEFAULT_SHAPE_HEIGHT),
        })),
        // Only the edges between two *new* nodes shape the layout. One pointing
        // at an existing shape says nothing about where this block should rank,
        // because that shape is staying where it is.
        edges
          .filter(
            (edge) => seen.has(edge.from.trim()) && seen.has(edge.to.trim())
          )
          .map((edge) => ({ from: edge.from.trim(), to: edge.to.trim() })),
        { direction }
      )

      const block = boundsOf(
        nodes.map((node) => {
          const at = placed.get(node.key) ?? { x: 0, y: 0 }
          return {
            ...at,
            w: round(node.w ?? DEFAULT_SHAPE_WIDTH),
            h: round(node.h ?? DEFAULT_SHAPE_HEIGHT),
          }
        })
      ) ?? { x: 0, y: 0, w: 0, h: 0 }

      const existing = [...shapes.values()]
      const origin = resolveOrigin(input, block, existing, edges, seen)

      const idByKey = new Map<string, string>()
      const drawnShapes: BoardShape[] = []
      for (const node of nodes) {
        const at = placed.get(node.key) ?? { x: 0, y: 0 }
        const shape = addShape({
          kind: node.kind ?? "rectangle",
          x: origin.x + at.x,
          y: origin.y + at.y,
          ...(node.w === undefined ? {} : { w: node.w }),
          ...(node.h === undefined ? {} : { h: node.h }),
          ...(node.text ? { text: node.text } : {}),
          ...(node.color ? { color: node.color } : {}),
        })
        idByKey.set(node.key, shape.id)
        drawnShapes.push(shape)
      }

      // A key names a box just drawn; anything else has to be a shape already
      // on the board, or it names nothing and the arrow cannot be drawn.
      const resolveEndpoint = (raw: string): string | undefined => {
        const byKey = idByKey.get(raw.trim())
        if (byKey) return byKey
        const id = normaliseId(raw)
        return shapes.has(id) ? id : undefined
      }

      let drawn = 0
      const unresolved: string[] = []
      for (const edge of edges) {
        const from = resolveEndpoint(edge.from)
        const to = resolveEndpoint(edge.to)
        if (!from || !to) {
          unresolved.push(`${edge.from} -> ${edge.to}`)
          continue
        }
        if (from === to) continue
        addConnection(from, to, edge.label)
        drawn += 1
      }

      const naming = nodes
        .map((node) => `${node.key}=${idByKey.get(node.key) ?? "?"}`)
        .join(", ")
      const missed =
        unresolved.length > 0
          ? ` These arrows named something that is not a node here and not a shape on the board, so they were skipped: ${unresolved.join("; ")}.`
          : ""

      // Only reachable through an explicit `x`/`y`, which skips the search for
      // clear space by design. The block is still drawn — this says what it
      // landed on rather than quietly stacking it on the user's work.
      const left = overlappingPairs(drawnShapes)
      const clash =
        left.length > 0
          ? ` ${left.join(", ")} overlap — move them, or omit x and y to have clear space chosen for you.`
          : ""

      return `Drew ${nodes.length} shape(s) and ${drawn} arrow(s), laid out ${direction === "right" ? "left to right" : "top to bottom"}. Ids: ${naming}.${missed}${clash}`
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
