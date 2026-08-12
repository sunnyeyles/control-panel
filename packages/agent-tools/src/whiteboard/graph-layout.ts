/**
 * Layered graph layout: nodes and the arrows between them in, a position for
 * each node out.
 *
 * **This module exists because coordinates are the thing the model is worst
 * at.** Asked for twelve positions it produces eleven good ones and one that
 * overlaps, and it cannot see the result to correct it. The same reasoning
 * already put `arrange_shapes` here rather than in the prompt; this is that
 * argument carried to its end, because a layout that respects the *arrows* is
 * the half `arrange_shapes` could never do — it never looked at connections at
 * all.
 *
 * **It imports nothing, deliberately.** Not even `@workspace/whiteboard-schema`, and so not
 * zod. Everything here is arithmetic over `{key, w, h}` and `{from, to}`, which
 * makes it exhaustively testable without a board, a session or a model, and
 * keeps the one genuinely intricate algorithm in this package free of any
 * reason to reach for a mock.
 *
 * The algorithm is Sugiyama's, in the reduced form a box diagram needs:
 *
 * 1. **Break cycles.** A retry loop or a feedback edge is ordinary in an
 *    architecture and must not hang the ranker. Back-edges are *dropped* for
 *    ranking rather than reversed — reversing `A → B → A` would demand that A
 *    rank after B as well as before it, which is the contradiction the drop
 *    avoids. Every edge is still drawn; only the ranking ignores them.
 * 2. **Rank** by longest path, so a node sits one step past its furthest
 *    predecessor and every arrow advances along the flow.
 * 3. **Order** within each rank by barycentre sweeps, which is what stops the
 *    arrows crossing.
 * 4. **Position**: ranks are laid out end to end along the flow; within a rank
 *    nodes are packed across it, then pulled toward the centre of their
 *    neighbours and re-separated. The separation pass is what makes
 *    "no two boxes overlap" a property of the algorithm rather than a hope.
 * 5. **Components** are laid out independently and stacked, so two unrelated
 *    boxes do not stretch the diagram that matters.
 *
 * Everything works in *along* and *across* axes and is mapped to x/y at the
 * very end. That is the whole of how one implementation serves both a
 * left-to-right pipeline and a top-to-bottom hierarchy: for `"right"`, along is
 * x; for `"down"`, along is y.
 */

/** Anything with a position and a size. Both a board shape and a bare box fit. */
export interface LayoutBox {
  x: number
  y: number
  w: number
  h: number
}

/** A node to place. No position — supplying one is the caller's job, not the model's. */
export interface LayoutNode {
  key: string
  w: number
  h: number
}

export interface LayoutEdge {
  from: string
  to: string
}

export type FlowDirection = "right" | "down"

export interface LayoutOptions {
  direction: FlowDirection
  /** Between one rank and the next. Wide enough for an arrow and its label. */
  gapAlong?: number
  /** Between neighbours within a rank. */
  gapAcross?: number
}

/**
 * Roomier than {@link DEFAULT_GAP_ACROSS} because this is the gap an arrow
 * crosses, and a labelled arrow needs somewhere to put the label.
 */
export const DEFAULT_GAP_ALONG = 120
export const DEFAULT_GAP_ACROSS = 80

/** How far a new block is placed from work that is already on the board. */
export const PLACEMENT_GAP = 160

/**
 * Sweeps of barycentre ordering, and of the priority pass after it.
 *
 * Four is where both stop paying. Crossings fall steeply over the first two and
 * are usually unchanged by the fifth, and every extra sweep is arithmetic in
 * the request path of a user watching an empty canvas.
 */
const ORDERING_SWEEPS = 4
const PRIORITY_PASSES = 4

/** Coordinates are pixels; fractions of one help nobody and bloat every op. */
function round(value: number): number {
  return Math.round(value)
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

/**
 * Do two boxes share any area?
 *
 * Touching edges is not overlapping — two boxes at x=0 and x=200, both 200
 * wide, sit flush and read as adjacent rather than as a mistake, so the
 * comparisons are strict.
 */
export function overlaps(a: LayoutBox, b: LayoutBox): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

/** The smallest box containing all of them, or undefined for none. */
export function boundsOf(boxes: LayoutBox[]): LayoutBox | undefined {
  const first = boxes[0]
  if (!first) return undefined

  let left = first.x
  let top = first.y
  let right = first.x + first.w
  let bottom = first.y + first.h

  for (const box of boxes) {
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.w)
    bottom = Math.max(bottom, box.y + box.h)
  }

  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * Where to put a block of the given size so it lands on nothing.
 *
 * Tries the middle of what the user is looking at first, because a diagram that
 * appears off screen has to be chased with `focus_viewport` and reads as though
 * nothing happened. Falls back to clear space past the right edge of everything
 * on the board — never on top of the user's work, which is the one outcome that
 * loses something they cannot get back without an undo.
 */
export function findFreeOrigin(
  existing: LayoutBox[],
  blockW: number,
  blockH: number,
  viewport?: LayoutBox
): { x: number; y: number } {
  const collides = (x: number, y: number): boolean => {
    const block = { x, y, w: blockW, h: blockH }
    return existing.some((box) => overlaps(block, box))
  }

  if (viewport) {
    const centred = {
      x: round(viewport.x + (viewport.w - blockW) / 2),
      y: round(viewport.y + (viewport.h - blockH) / 2),
    }
    if (!collides(centred.x, centred.y)) return centred
  }

  const bounds = boundsOf(existing)
  if (!bounds) return { x: 0, y: 0 }

  const beside = {
    x: round(bounds.x + bounds.w + PLACEMENT_GAP),
    y: round(bounds.y),
  }
  if (!collides(beside.x, beside.y)) return beside

  // Nothing to the right either, which takes a board laid out in a single tall
  // column. Below the lot is always free.
  return {
    x: round(bounds.x),
    y: round(bounds.y + bounds.h + PLACEMENT_GAP),
  }
}

interface Adjacency {
  outgoing: Map<string, string[]>
  incoming: Map<string, string[]>
}

/**
 * Directed adjacency, with the three edges that cannot be laid out dropped:
 * self-loops, duplicates, and any edge naming a node we were not given. Each is
 * a thing a model produces and none of them is worth failing a whole diagram
 * over — the arrow is simply not part of the ranking.
 */
function buildAdjacency(keys: string[], edges: LayoutEdge[]): Adjacency {
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const key of keys) {
    outgoing.set(key, [])
    incoming.set(key, [])
  }

  for (const edge of edges) {
    if (edge.from === edge.to) continue
    const out = outgoing.get(edge.from)
    const into = incoming.get(edge.to)
    if (!out || !into) continue
    if (out.includes(edge.to)) continue
    out.push(edge.to)
    into.push(edge.from)
  }

  return { outgoing, incoming }
}

/** Weakly connected components, in the order their first node was given. */
function findComponents(keys: string[], adjacency: Adjacency): string[][] {
  const seen = new Set<string>()
  const components: string[][] = []
  const order = new Map(keys.map((key, index) => [key, index]))

  for (const start of keys) {
    if (seen.has(start)) continue

    const component: string[] = []
    const queue = [start]
    seen.add(start)

    for (let i = 0; i < queue.length; i += 1) {
      const key = queue[i]
      if (key === undefined) continue
      component.push(key)
      const neighbours = [
        ...(adjacency.outgoing.get(key) ?? []),
        ...(adjacency.incoming.get(key) ?? []),
      ]
      for (const next of neighbours) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }

    // Back into the caller's order, so a component's ranks are ordered the way
    // the model listed its nodes rather than the way the search reached them.
    component.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    components.push(component)
  }

  return components
}

/** Edges that close a cycle, found by DFS. See the module note on dropping them. */
function findBackEdges(keys: string[], adjacency: Adjacency): Set<string> {
  const back = new Set<string>()
  const UNSEEN = 0
  const OPEN = 1
  const DONE = 2
  const state = new Map<string, number>(keys.map((key) => [key, UNSEEN]))

  const visit = (key: string): void => {
    state.set(key, OPEN)
    for (const next of adjacency.outgoing.get(key) ?? []) {
      const seen = state.get(next) ?? UNSEEN
      if (seen === OPEN) back.add(edgeKey(key, next))
      else if (seen === UNSEEN) visit(next)
    }
    state.set(key, DONE)
  }

  for (const key of keys) {
    if ((state.get(key) ?? UNSEEN) === UNSEEN) visit(key)
  }

  return back
}

/** Longest-path ranking over the acyclic subgraph, by Kahn's algorithm. */
function rankNodes(
  keys: string[],
  adjacency: Adjacency,
  back: Set<string>
): Map<string, number> {
  const indegree = new Map<string, number>(keys.map((key) => [key, 0]))
  for (const from of keys) {
    for (const to of adjacency.outgoing.get(from) ?? []) {
      if (back.has(edgeKey(from, to))) continue
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }

  const rank = new Map<string, number>()
  const queue = keys.filter((key) => (indegree.get(key) ?? 0) === 0)
  for (const key of queue) rank.set(key, 0)

  for (let i = 0; i < queue.length; i += 1) {
    const key = queue[i]
    if (key === undefined) continue
    const here = rank.get(key) ?? 0
    for (const to of adjacency.outgoing.get(key) ?? []) {
      if (back.has(edgeKey(key, to))) continue
      rank.set(to, Math.max(rank.get(to) ?? 0, here + 1))
      const remaining = (indegree.get(to) ?? 0) - 1
      indegree.set(to, remaining)
      if (remaining === 0) queue.push(to)
    }
  }

  // Total by construction once back-edges are gone, but a rank of 0 is a
  // defensible answer and an undefined one is a NaN coordinate.
  for (const key of keys) if (!rank.has(key)) rank.set(key, 0)

  return rank
}

/**
 * Reorder each rank so its nodes sit near their neighbours, which is what stops
 * arrows crossing. Sorting is stable, so nodes with no neighbour in the
 * adjacent rank keep the order the caller gave — the model's own listing order
 * is a real signal and is the right tiebreak.
 */
function orderRanks(layers: string[][], adjacency: Adjacency): string[][] {
  const ordered = layers.map((layer) => [...layer])

  /**
   * Reorder one rank against the rank before it (`step: -1`, reading forward
   * from predecessors) or the one after it (`step: 1`, reading back from
   * successors).
   */
  const sweep = (index: number, step: -1 | 1): void => {
    const layer = ordered[index]
    const reference = ordered[index + step]
    if (!layer || !reference) return

    const neighbours = step === -1 ? adjacency.incoming : adjacency.outgoing
    const position = new Map(reference.map((key, at) => [key, at]))
    const barycentre = new Map<string, number>()
    layer.forEach((key, at) => {
      const near = (neighbours.get(key) ?? [])
        .map((neighbour) => position.get(neighbour))
        .filter((value): value is number => value !== undefined)
      barycentre.set(key, near.length === 0 ? at : mean(near))
    })

    layer.sort((a, b) => (barycentre.get(a) ?? 0) - (barycentre.get(b) ?? 0))
  }

  for (let pass = 0; pass < ORDERING_SWEEPS; pass += 1) {
    for (let i = 1; i < ordered.length; i += 1) sweep(i, -1)
    for (let i = ordered.length - 2; i >= 0; i -= 1) sweep(i, 1)
  }

  return ordered
}

/**
 * Place every node across its rank.
 *
 * Packed in order first and each rank centred on the widest, which alone draws
 * a decent tree. The priority passes then pull each node toward the middle of
 * its neighbours and re-separate the rank left to right, so a fan-out sits
 * under its parent instead of starting at the same edge as every other rank.
 *
 * **The separation is why no two boxes can overlap.** A node is placed at what
 * it wants or at the end of the node before it, whichever is further along, so
 * within a rank the sequence is monotonic by construction, and ranks cannot
 * reach each other because the along axis separates them.
 */
function assignAcross(
  layers: string[][],
  extent: Map<string, number>,
  gap: number,
  adjacency: Adjacency
): Map<string, number> {
  const across = new Map<string, number>()

  for (const layer of layers) {
    let cursor = 0
    for (const key of layer) {
      across.set(key, cursor)
      cursor += (extent.get(key) ?? 0) + gap
    }
  }

  const widthOf = (layer: string[]): number => {
    const last = layer[layer.length - 1]
    if (last === undefined) return 0
    return (across.get(last) ?? 0) + (extent.get(last) ?? 0)
  }

  const widest = Math.max(0, ...layers.map(widthOf))
  for (const layer of layers) {
    const shift = (widest - widthOf(layer)) / 2
    for (const key of layer) across.set(key, (across.get(key) ?? 0) + shift)
  }

  const centreOf = (key: string): number =>
    (across.get(key) ?? 0) + (extent.get(key) ?? 0) / 2

  for (let pass = 0; pass < PRIORITY_PASSES; pass += 1) {
    const forward = pass % 2 === 0
    const order = forward
      ? layers.map((_, index) => index)
      : layers.map((_, index) => layers.length - 1 - index)
    const neighbours = forward ? adjacency.incoming : adjacency.outgoing

    for (const index of order) {
      const layer = layers[index]
      if (!layer) continue

      const desired = new Map<string, number>()
      for (const key of layer) {
        const near = (neighbours.get(key) ?? [])
          .filter((neighbour) => across.has(neighbour))
          .map(centreOf)
        const target = near.length === 0 ? centreOf(key) : mean(near)
        desired.set(key, target - (extent.get(key) ?? 0) / 2)
      }

      let limit = -Infinity
      for (const key of layer) {
        const place = Math.max(desired.get(key) ?? 0, limit)
        across.set(key, place)
        limit = place + (extent.get(key) ?? 0) + gap
      }
    }
  }

  return across
}

/**
 * Lay out one graph, with its top-left corner at the origin.
 *
 * Returns a position per node key. A key the caller passed always comes back;
 * an edge naming a key it did not is ignored, per {@link buildAdjacency}.
 */
export function layerGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (nodes.length === 0) return positions

  const {
    direction,
    gapAlong = DEFAULT_GAP_ALONG,
    gapAcross = DEFAULT_GAP_ACROSS,
  } = options
  const horizontal = direction === "right"

  // Deduped, because two nodes sharing a key would each overwrite the other's
  // position and the second would silently vanish under the first.
  const unique = new Map<string, LayoutNode>()
  for (const node of nodes)
    if (!unique.has(node.key)) unique.set(node.key, node)
  const keys = [...unique.keys()]

  const extentAlong = new Map<string, number>()
  const extentAcross = new Map<string, number>()
  for (const node of unique.values()) {
    extentAlong.set(node.key, horizontal ? node.w : node.h)
    extentAcross.set(node.key, horizontal ? node.h : node.w)
  }

  const adjacency = buildAdjacency(keys, edges)

  let componentOffset = 0
  for (const component of findComponents(keys, adjacency)) {
    const back = findBackEdges(component, adjacency)
    const rank = rankNodes(component, adjacency, back)

    const depth = Math.max(0, ...component.map((key) => rank.get(key) ?? 0))
    const layers: string[][] = Array.from({ length: depth + 1 }, () => [])
    for (const key of component) layers[rank.get(key) ?? 0]?.push(key)

    const ordered = orderRanks(layers, adjacency)
    const across = assignAcross(ordered, extentAcross, gapAcross, adjacency)

    let alongCursor = 0
    let componentExtent = 0
    for (const layer of ordered) {
      const band = Math.max(0, ...layer.map((key) => extentAlong.get(key) ?? 0))
      for (const key of layer) {
        // Centred in its band, so a short box beside a tall one reads as being
        // on the same step rather than as having drifted off it.
        const along = alongCursor + (band - (extentAlong.get(key) ?? 0)) / 2
        const off = (across.get(key) ?? 0) + componentOffset
        positions.set(
          key,
          horizontal
            ? { x: round(along), y: round(off) }
            : { x: round(off), y: round(along) }
        )
        componentExtent = Math.max(
          componentExtent,
          (across.get(key) ?? 0) + (extentAcross.get(key) ?? 0)
        )
      }
      alongCursor += band + gapAlong
    }

    componentOffset += componentExtent + gapAcross * 2
  }

  // Normalise to the origin. Every caller translates the result somewhere, and
  // a block whose own corner is at (0, 0) is the one that lands where it is put.
  const placed = [...positions.values()]
  const minX = Math.min(...placed.map((p) => p.x))
  const minY = Math.min(...placed.map((p) => p.y))
  for (const [key, point] of positions) {
    positions.set(key, { x: point.x - minX, y: point.y - minY })
  }

  return positions
}
