/**
 * The layout engine is the one algorithm in this package with no I/O and no
 * model anywhere near it, so it is tested the way arithmetic should be: by
 * asserting the properties a diagram must have, rather than by pinning
 * coordinates that any tuning of a gap constant would break.
 *
 * Four properties carry almost all of it — no two boxes overlap, every arrow
 * advances along the flow, ranks are what the longest path says they are, and
 * a cycle terminates. Everything the model gets wrong by hand is one of those.
 */

import { describe, expect, it } from "vitest"

import {
  boundsOf,
  findFreeOrigin,
  layerGraph,
  overlaps,
  type LayoutEdge,
  type LayoutNode,
} from "./graph-layout.ts"

const W = 200
const H = 120

function nodes(...keys: string[]): LayoutNode[] {
  return keys.map((key) => ({ key, w: W, h: H }))
}

function edges(...pairs: string[]): LayoutEdge[] {
  return pairs.map((pair) => {
    const [from, to] = pair.split(">")
    return { from: from ?? "", to: to ?? "" }
  })
}

/** Positions back as boxes, so the overlap and ordering checks can use them. */
function boxes(
  placed: Map<string, { x: number; y: number }>,
  sized: LayoutNode[]
) {
  return sized.map((node) => {
    const at = placed.get(node.key)
    if (!at) throw new Error(`${node.key} was not placed`)
    return { key: node.key, x: at.x, y: at.y, w: node.w, h: node.h }
  })
}

function anyOverlap(placed: ReturnType<typeof boxes>): string | undefined {
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i]
      const b = placed[j]
      if (a && b && overlaps(a, b)) return `${a.key} overlaps ${b.key}`
    }
  }
  return undefined
}

describe("overlaps", () => {
  it("is false for boxes that merely touch", () => {
    expect(
      overlaps({ x: 0, y: 0, w: 200, h: 120 }, { x: 200, y: 0, w: 200, h: 120 })
    ).toBe(false)
  })

  it("is true for a one-pixel intrusion", () => {
    expect(
      overlaps({ x: 0, y: 0, w: 200, h: 120 }, { x: 199, y: 0, w: 200, h: 120 })
    ).toBe(true)
  })

  it("needs both axes to intersect", () => {
    expect(
      overlaps(
        { x: 0, y: 0, w: 200, h: 120 },
        { x: 100, y: 500, w: 200, h: 120 }
      )
    ).toBe(false)
  })
})

describe("boundsOf", () => {
  it("is undefined for nothing", () => {
    expect(boundsOf([])).toBeUndefined()
  })

  it("wraps every corner", () => {
    expect(
      boundsOf([
        { x: 10, y: 20, w: 100, h: 100 },
        { x: -50, y: 300, w: 40, h: 40 },
      ])
    ).toEqual({ x: -50, y: 20, w: 160, h: 320 })
  })
})

describe("findFreeOrigin", () => {
  const viewport = { x: 0, y: 0, w: 1200, h: 800 }

  it("centres a block in the viewport when the board is empty", () => {
    expect(findFreeOrigin([], 400, 200, viewport)).toEqual({ x: 400, y: 300 })
  })

  it("is the origin with no viewport and no shapes", () => {
    expect(findFreeOrigin([], 400, 200)).toEqual({ x: 0, y: 0 })
  })

  it("steps clear of work already in the middle of the view", () => {
    const occupied = [{ x: 300, y: 200, w: 600, h: 400 }]
    const origin = findFreeOrigin(occupied, 400, 200, viewport)

    expect(overlaps({ ...origin, w: 400, h: 200 }, occupied[0]!)).toBe(false)
    // Past the right edge of what is there, not on top of it.
    expect(origin.x).toBeGreaterThan(900)
  })

  it("never lands on the user's work, even in a single tall column", () => {
    // A column tall enough that "beside it" is still inside the viewport test
    // and "below it" is the only free answer left.
    const column = Array.from({ length: 6 }, (_, i) => ({
      x: 0,
      y: i * 200,
      w: 2000,
      h: 180,
    }))
    const origin = findFreeOrigin(column, 400, 200, viewport)

    const block = { ...origin, w: 400, h: 200 }
    expect(column.some((box) => overlaps(block, box))).toBe(false)
  })
})

describe("layerGraph", () => {
  it("places nothing for no nodes", () => {
    expect(layerGraph([], [], { direction: "right" }).size).toBe(0)
  })

  it("puts a chain in flow order, left to right", () => {
    const sized = nodes("a", "b", "c")
    const placed = layerGraph(sized, edges("a>b", "b>c"), {
      direction: "right",
    })
    const [a, b, c] = boxes(placed, sized)

    expect(a!.x).toBeLessThan(b!.x)
    expect(b!.x).toBeLessThan(c!.x)
    // One rank each, so they share the across axis.
    expect(a!.y).toBe(b!.y)
    expect(b!.y).toBe(c!.y)
  })

  it("puts a chain top to bottom when the flow is down", () => {
    const sized = nodes("a", "b", "c")
    const placed = layerGraph(sized, edges("a>b", "b>c"), { direction: "down" })
    const [a, b, c] = boxes(placed, sized)

    expect(a!.y).toBeLessThan(b!.y)
    expect(b!.y).toBeLessThan(c!.y)
    expect(a!.x).toBe(b!.x)
  })

  it("ranks by the longest path, not the shortest", () => {
    // a → b → c and a → c. c must clear b, or the long arrow runs backwards.
    const sized = nodes("a", "b", "c")
    const placed = layerGraph(sized, edges("a>b", "b>c", "a>c"), {
      direction: "right",
    })
    const [a, b, c] = boxes(placed, sized)

    expect(a!.x).toBeLessThan(b!.x)
    expect(b!.x).toBeLessThan(c!.x)
  })

  it("spreads a fan-out across the rank without overlapping", () => {
    const sized = nodes("root", "one", "two", "three")
    const placed = layerGraph(
      sized,
      edges("root>one", "root>two", "root>three"),
      {
        direction: "right",
      }
    )
    const laid = boxes(placed, sized)

    expect(anyOverlap(laid)).toBeUndefined()
    const [root, one, two, three] = laid
    expect(one!.x).toBe(two!.x)
    expect(two!.x).toBe(three!.x)
    expect(root!.x).toBeLessThan(one!.x)
    // And the parent sits against the middle of its children, not at the top.
    const middle = (one!.y + three!.y + H) / 2
    expect(Math.abs(root!.y + H / 2 - middle)).toBeLessThan(1)
  })

  it("does not stack the sources of a fan-in on each other", () => {
    const sized = nodes("one", "two", "three", "sink")
    const placed = layerGraph(
      sized,
      edges("one>sink", "two>sink", "three>sink"),
      {
        direction: "right",
      }
    )

    expect(anyOverlap(boxes(placed, sized))).toBeUndefined()
  })

  it("terminates on a cycle and still advances the arrows it can", () => {
    const sized = nodes("a", "b", "c")
    const placed = layerGraph(sized, edges("a>b", "b>c", "c>a"), {
      direction: "right",
    })
    const [a, b, c] = boxes(placed, sized)

    // The back-edge c → a is dropped for ranking, so the forward path still
    // reads left to right. Where c → a is drawn is the renderer's problem.
    expect(a!.x).toBeLessThan(b!.x)
    expect(b!.x).toBeLessThan(c!.x)
  })

  it("survives a self-loop", () => {
    const sized = nodes("a", "b")
    const placed = layerGraph(sized, edges("a>a", "a>b"), {
      direction: "right",
    })
    const [a, b] = boxes(placed, sized)

    expect(a!.x).toBeLessThan(b!.x)
  })

  it("ignores an edge naming a node it was not given", () => {
    const sized = nodes("a", "b")
    const placed = layerGraph(sized, edges("a>b", "b>ghost"), {
      direction: "right",
    })

    expect(placed.size).toBe(2)
    expect(placed.has("ghost")).toBe(false)
  })

  it("keeps two components apart", () => {
    const sized = nodes("a", "b", "x", "y")
    const placed = layerGraph(sized, edges("a>b", "x>y"), {
      direction: "right",
    })
    const laid = boxes(placed, sized)

    expect(anyOverlap(laid)).toBeUndefined()
    const [a, , x] = laid
    // Stacked across the flow, so each component starts its own chain.
    expect(a!.x).toBe(x!.x)
    expect(a!.y).not.toBe(x!.y)
  })

  it("lays out unconnected nodes without piling them up", () => {
    const sized = nodes("a", "b", "c", "d")
    const placed = layerGraph(sized, [], { direction: "right" })

    expect(anyOverlap(boxes(placed, sized))).toBeUndefined()
  })

  it("starts at the origin so the caller can put the block anywhere", () => {
    const sized = nodes("a", "b", "c")
    const placed = layerGraph(sized, edges("a>b", "a>c"), {
      direction: "right",
    })
    const laid = boxes(placed, sized)

    expect(Math.min(...laid.map((box) => box.x))).toBe(0)
    expect(Math.min(...laid.map((box) => box.y))).toBe(0)
  })

  it("never overlaps on a realistic architecture", () => {
    const sized = nodes(
      "client",
      "cdn",
      "api",
      "auth",
      "queue",
      "worker",
      "db",
      "cache",
      "s3"
    )
    const placed = layerGraph(
      sized,
      edges(
        "client>cdn",
        "cdn>api",
        "api>auth",
        "api>cache",
        "api>db",
        "api>queue",
        "queue>worker",
        "worker>db",
        "worker>s3"
      ),
      { direction: "right" }
    )
    const laid = boxes(placed, sized)

    expect(anyOverlap(laid)).toBeUndefined()
  })

  it("advances every forward arrow along the flow axis", () => {
    const sized = nodes("client", "api", "queue", "worker", "db")
    const list = edges(
      "client>api",
      "api>queue",
      "queue>worker",
      "worker>db",
      "api>db"
    )
    const placed = layerGraph(sized, list, { direction: "right" })
    const at = new Map(boxes(placed, sized).map((box) => [box.key, box]))

    for (const edge of list) {
      const from = at.get(edge.from)
      const to = at.get(edge.to)
      expect(from!.x, `${edge.from} → ${edge.to}`).toBeLessThan(to!.x)
    }
  })

  it("honours differing sizes without letting a tall box collide", () => {
    const sized: LayoutNode[] = [
      { key: "a", w: 200, h: 400 },
      { key: "b", w: 120, h: 60 },
      { key: "c", w: 320, h: 200 },
    ]
    const placed = layerGraph(sized, edges("a>b", "a>c"), {
      direction: "right",
    })

    expect(anyOverlap(boxes(placed, sized))).toBeUndefined()
  })

  it("is deterministic", () => {
    const sized = nodes("a", "b", "c", "d", "e")
    const list = edges("a>b", "a>c", "b>d", "c>d", "d>e")
    const once = layerGraph(sized, list, { direction: "right" })
    const twice = layerGraph(sized, list, { direction: "right" })

    expect([...once.entries()]).toEqual([...twice.entries()])
  })

  it("places a duplicated key once", () => {
    const placed = layerGraph(
      [...nodes("a"), ...nodes("a"), ...nodes("b")],
      edges("a>b"),
      { direction: "right" }
    )

    expect(placed.size).toBe(2)
  })
})
