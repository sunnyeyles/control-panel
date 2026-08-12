import { describe, expect, it } from "vitest"

import { createBoardSession } from "./session.ts"
import type { BoardContext, BoardShape } from "@workspace/whiteboard-schema"

function shape(overrides: Partial<BoardShape> & { id: string }): BoardShape {
  return {
    kind: "rectangle",
    x: 0,
    y: 0,
    w: 200,
    h: 120,
    ...overrides,
  }
}

function context(overrides: Partial<BoardContext> = {}): BoardContext {
  return {
    shapes: [],
    connections: [],
    selection: [],
    viewport: { x: 0, y: 0, w: 1200, h: 800 },
    recentEdits: [],
    ...overrides,
  }
}

describe("id allocation", () => {
  it("numbers from s1 on an empty board", () => {
    const session = createBoardSession(context())

    session.createShape({ kind: "rectangle", x: 0, y: 0 })
    session.createShape({ kind: "rectangle", x: 0, y: 0 })

    expect(session.shapes().map((s) => s.id)).toEqual(["s1", "s2"])
  })

  it("skips ids the snapshot already uses, so numbering self-heals", () => {
    // The user kept s1 and s3 from an earlier turn and deleted s2. The freed
    // name is reusable; the two in use are not.
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s3" })] })
    )

    session.createShape({ kind: "rectangle", x: 0, y: 0 })
    session.createShape({ kind: "rectangle", x: 0, y: 0 })

    expect(session.shapes().map((s) => s.id)).toEqual(["s1", "s3", "s2", "s4"])
  })

  // Everything that counts as "taken": an arrow's id, because arrows are
  // shapes too, and an id the board describes nowhere but `knownIds` reports.
  it("treats every id the turn can see as taken, wherever it was named", () => {
    const fromArrow = createBoardSession(
      context({
        shapes: [shape({ id: "s1" }), shape({ id: "s2" })],
        connections: [{ id: "s3", fromId: "s1", toId: "s2" }],
      })
    )
    fromArrow.createShape({ kind: "rectangle", x: 0, y: 0 })
    expect(fromArrow.shapes().at(-1)?.id).toBe("s4")

    const fromKnownIds = createBoardSession(
      context({ shapes: [shape({ id: "s1" })], knownIds: ["s1", "s2", "s3"] })
    )
    fromKnownIds.createShape({ kind: "rectangle", x: 0, y: 0 })
    expect(fromKnownIds.shapes().at(-1)?.id).toBe("s4")

    // A hand-drawn id is not in the sN space at all, so it blocks nothing.
    const handDrawn = createBoardSession(
      context({ shapes: [shape({ id: "Xk3p9vQ2" })] })
    )
    expect(handDrawn.createShape({ kind: "note", x: 0, y: 0 })).toContain("s1")
  })
})

describe("ops", () => {
  it("records a create op carrying the allocated id and defaults", () => {
    const session = createBoardSession(context())

    session.createShape({ kind: "cloud", x: 10.4, y: -20.6, text: "S3" })

    expect(session.flush()).toEqual([
      {
        op: "create",
        id: "s1",
        kind: "cloud",
        x: 10,
        y: -21,
        w: 200,
        h: 120,
        text: "S3",
      },
    ])
  })

  it("clears the buffer, so a second tool call does not resend the first's ops", () => {
    const session = createBoardSession(context())

    session.createShape({ kind: "rectangle", x: 0, y: 0 })
    expect(session.flush()).toHaveLength(1)
    expect(session.flush()).toEqual([])
  })

  it("records nothing when a mutation was refused", () => {
    const session = createBoardSession(context())

    session.moveShape({ id: "s9", x: 0, y: 0 })

    expect(session.flush()).toEqual([])
  })
})

describe("validation", () => {
  it("corrects an unknown id by listing what does exist", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s2" })] })
    )

    const message = session.moveShape({ id: "s9", x: 0, y: 0 })

    expect(message).toContain('no shape with id "s9"')
    expect(message).toContain("s1, s2")
  })

  it("accepts a tldraw-prefixed id, which is a transcription habit not a mistake", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" })] })
    )

    expect(session.moveShape({ id: "shape:s1", x: 50, y: 60 })).toContain(
      "Moved s1"
    )
    expect(session.shapes()[0]).toMatchObject({ x: 50, y: 60 })
  })

  it("refuses a mutation that could not mean anything, and records no op", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" })] })
    )

    expect(session.connectShapes({ fromId: "s1", toId: "s1" })).toContain(
      "itself"
    )
    expect(session.updateShape({ id: "s1" })).toContain("at least one of")
    expect(session.flush()).toEqual([])
  })

  it("deletes what it can, dedupes a respelling, and names what it could not", () => {
    const board = context({
      shapes: [shape({ id: "s1" }), shape({ id: "s2" })],
      connections: [{ id: "s3", fromId: "s1", toId: "s2" }],
    })

    const partial = createBoardSession(board)
    const message = partial.deleteShapes(["s1", "s9"])
    expect(message).toContain("Deleted s1")
    expect(message).toContain("No shape matched s9")
    expect(partial.flush()).toEqual([{ op: "delete", ids: ["s1"] }])

    // The second spelling must not come back as "No shape matched" — a
    // correction that contradicts the deletion beside it.
    const respelt = createBoardSession(board)
    const deduped = respelt.deleteShapes(["s1", "shape:s1"])
    expect(deduped).toContain("Deleted s1")
    expect(deduped).not.toContain("No shape matched")
    expect(respelt.flush()).toEqual([{ op: "delete", ids: ["s1"] }])

    // Nothing deleted at all lists the arrows too, not only the boxes.
    const missed = createBoardSession(board)
    expect(missed.deleteShapes(["s9"])).toContain("s1, s2, s3")
  })

  it("drops arrows whose endpoint was deleted", () => {
    const session = createBoardSession(
      context({
        shapes: [shape({ id: "s1" }), shape({ id: "s2" })],
        connections: [{ id: "s3", fromId: "s1", toId: "s2" }],
      })
    )

    session.deleteShapes(["s1"])

    expect(session.connections()).toEqual([])
  })

  it("deletes an arrow named on its own, leaving both endpoints", () => {
    const session = createBoardSession(
      context({
        shapes: [shape({ id: "s1" }), shape({ id: "s2" })],
        connections: [{ id: "s3", fromId: "s1", toId: "s2" }],
      })
    )

    expect(session.deleteShapes(["s3"])).toContain("Deleted s3")
    expect(session.connections()).toEqual([])
    expect(session.shapes().map((s) => s.id)).toEqual(["s1", "s2"])
    expect(session.flush()).toEqual([{ op: "delete", ids: ["s3"] }])
  })
})

describe("layouts", () => {
  const three = context({
    shapes: [
      shape({ id: "s1", x: 0, y: 0, w: 100, h: 100 }),
      shape({ id: "s2", x: 500, y: 40, w: 100, h: 100 }),
      shape({ id: "s3", x: 200, y: 90, w: 100, h: 100 }),
    ],
  })

  it("lays a row out in the order the shapes already sit, not the order given", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({ ids: ["s2", "s3", "s1"], layout: "row", gap: 50 })

    expect(session.shapes()).toMatchObject([
      { id: "s1", x: 0, y: 0 },
      { id: "s2", x: 300, y: 0 },
      { id: "s3", x: 150, y: 0 },
    ])
  })

  it("stacks a column at the leftmost x", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({
      ids: ["s1", "s2", "s3"],
      layout: "column",
      gap: 20,
    })

    expect(session.shapes()).toMatchObject([
      { id: "s1", x: 0, y: 0 },
      { id: "s2", x: 0, y: 120 },
      { id: "s3", x: 0, y: 240 },
    ])
  })

  it("fills a grid on a uniform cell so rows line up", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "grid", gap: 40 })

    // ceil(sqrt(3)) = 2 columns, cell 140x140.
    expect(session.shapes()).toMatchObject([
      { id: "s1", x: 0, y: 0 },
      { id: "s2", x: 0, y: 140 },
      { id: "s3", x: 140, y: 0 },
    ])
  })

  it("aligns one edge and leaves the other axis alone", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "align-top" })

    expect(session.shapes()).toMatchObject([
      { id: "s1", x: 0, y: 0 },
      { id: "s2", x: 500, y: 0 },
      { id: "s3", x: 200, y: 0 },
    ])
  })

  it("aligns right on the rightmost edge, accounting for width", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "align-right" })

    expect(session.shapes().map((s) => s.x)).toEqual([500, 500, 500])
  })

  it("distributes without moving the outermost two", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({
      ids: ["s1", "s2", "s3"],
      layout: "distribute-horizontal",
    })

    expect(session.shapes()).toMatchObject([
      { id: "s1", x: 0 },
      { id: "s2", x: 500 },
      { id: "s3", x: 250 },
    ])
  })

  it("does not overlap shapes wider than the extent they sit in", () => {
    // 300px of shape in a 220px span — without the clamp the step goes
    // negative and the layout walks backwards over itself.
    const session = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0, w: 100, h: 100 }),
          shape({ id: "s2", x: 60, y: 0, w: 100, h: 100 }),
          shape({ id: "s3", x: 120, y: 0, w: 100, h: 100 }),
        ],
      })
    )

    session.arrangeShapes({
      ids: ["s1", "s2", "s3"],
      layout: "distribute-horizontal",
    })

    expect(session.shapes().map((s) => s.x)).toEqual([0, 100, 200])
  })

  it("emits one batch of moves, and none for shapes already in place", () => {
    const session = createBoardSession(three)

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "align-top" })

    // s1 is already at y=0, so only the other two move.
    expect(session.flush()).toEqual([
      { op: "move", id: "s2", x: 500, y: 0 },
      { op: "move", id: "s3", x: 200, y: 0 },
    ])
  })

  // Two shapes for anything, three to distribute, and the count is of shapes
  // rather than of spellings — `s1` and `shape:s1` are one.
  it("counts existing, deduped shapes before it will arrange anything", () => {
    const session = createBoardSession(three)
    const one = createBoardSession(context({ shapes: [shape({ id: "s1" })] }))

    expect(one.arrangeShapes({ ids: ["s1", "s9"], layout: "row" })).toContain(
      "at least two shapes that exist"
    )
    expect(
      session.arrangeShapes({ ids: ["s1", "shape:s1"], layout: "row" })
    ).toContain("at least two shapes that exist")
    expect(
      session.arrangeShapes({
        ids: ["s1", "s2"],
        layout: "distribute-horizontal",
      })
    ).toContain("at least three")
    expect(
      session.arrangeShapes({
        ids: ["s1", "s1", "s2"],
        layout: "distribute-horizontal",
      })
    ).toContain("at least three")
  })
})

describe("focus", () => {
  it("fits the whole board when given no ids", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s2" })] })
    )

    session.focusViewport()

    expect(session.flush()).toEqual([{ op: "focus", ids: ["s1", "s2"] }])
  })

  it("refuses rather than focusing on nothing", () => {
    const session = createBoardSession(context())

    expect(session.focusViewport()).toContain("Nothing to focus on")
    expect(session.flush()).toEqual([])
  })
})

describe("connections", () => {
  it("allocates the arrow its own id and reports it", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s2" })] })
    )

    const message = session.connectShapes({
      fromId: "s1",
      toId: "s2",
      label: "writes",
    })

    expect(message).toContain("arrow s3")
    expect(session.flush()).toEqual([
      { op: "connect", id: "s3", fromId: "s1", toId: "s2", label: "writes" },
    ])
  })
})

/** Every pair in a set that shares any area. Empty is the property under test. */
function overlappingPairs(shapes: BoardShape[]): string[] {
  const pairs: string[] = []
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const a = shapes[i]
      const b = shapes[j]
      if (!a || !b) continue
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        pairs.push(`${a.text ?? a.id} and ${b.text ?? b.id}`)
      }
    }
  }
  return pairs
}

describe("overlap reporting", () => {
  it("names what a new shape landed on, and still creates it", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1", x: 0, y: 0 })] })
    )

    const message = session.createShape({ kind: "rectangle", x: 50, y: 50 })

    expect(message).toContain("overlaps s1")
    expect(message).toContain("draw_diagram")
    // Reported, not refused — the shape exists and the op went out.
    expect(session.shapes()).toHaveLength(2)
    expect(session.flush()).toHaveLength(1)

    // Landing clear says nothing, and a text caption is exempt wherever it lands.
    expect(
      session.createShape({ kind: "rectangle", x: 900, y: 0 })
    ).not.toContain("overlaps")
    expect(session.createShape({ kind: "text", x: 10, y: 10 })).not.toContain(
      "overlaps"
    )
  })

  it("flags a move that lands on something", () => {
    const session = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0 }),
          shape({ id: "s2", x: 500, y: 0 }),
        ],
      })
    )

    expect(session.moveShape({ id: "s2", x: 20, y: 20 })).toContain(
      "now overlaps s1"
    )
  })

  it("admits it when align-left stacks two shapes", () => {
    // The layout did exactly what was asked and the result is unreadable. The
    // prompt used to claim arranging could not do this. It can.
    const session = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0 }),
          shape({ id: "s2", x: 600, y: 40 }),
        ],
      })
    )

    const message = session.arrangeShapes({
      ids: ["s1", "s2"],
      layout: "align-left",
    })

    expect(message).toContain("s1 and s2 now overlap")

    // And a row, which cannot produce one, says nothing.
    const row = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0 }),
          shape({ id: "s2", x: 600, y: 40 }),
        ],
      })
    )
    expect(
      row.arrangeShapes({ ids: ["s1", "s2"], layout: "row" })
    ).not.toContain("overlap")
  })

  it("names a shape the layout buried that it was never asked to arrange", () => {
    const session = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0 }),
          shape({ id: "s2", x: 0, y: 200 }),
          shape({ id: "s3", x: 320, y: 0, text: "not selected" }),
        ],
        connections: [{ id: "s4", fromId: "s1", toId: "s2" }],
      })
    )

    const message = session.arrangeShapes({
      ids: ["s1", "s2"],
      layout: "flow-right",
    })

    expect(message).toContain("s2 and s3 now overlap")
  })
})

describe("flow layouts", () => {
  /** Three boxes in a chain, deliberately placed in the wrong visual order. */
  function chain() {
    return createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 800, y: 300, text: "Client" }),
          shape({ id: "s2", x: 0, y: 0, text: "API" }),
          shape({ id: "s3", x: 400, y: 600, text: "DB" }),
        ],
        connections: [
          { id: "s4", fromId: "s1", toId: "s2" },
          { id: "s5", fromId: "s2", toId: "s3" },
        ],
      })
    )
  }

  it("orders shapes by the arrows, not by where they happen to sit", () => {
    const session = chain()

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "flow-right" })
    const at = new Map(session.shapes().map((s) => [s.id, s]))

    expect(at.get("s1")!.x).toBeLessThan(at.get("s2")!.x)
    expect(at.get("s2")!.x).toBeLessThan(at.get("s3")!.x)
  })

  it("ranks downward for flow-down", () => {
    const session = chain()

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "flow-down" })
    const at = new Map(session.shapes().map((s) => [s.id, s]))

    expect(at.get("s1")!.y).toBeLessThan(at.get("s2")!.y)
    expect(at.get("s2")!.y).toBeLessThan(at.get("s3")!.y)
  })

  it("anchors at the selection's existing top-left rather than teleporting it", () => {
    const session = chain()

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "flow-right" })
    const shapes = session.shapes()

    expect(Math.min(...shapes.map((s) => s.x))).toBe(0)
    expect(Math.min(...shapes.map((s) => s.y))).toBe(0)
  })

  it("leaves no overlap behind", () => {
    const session = chain()

    session.arrangeShapes({ ids: ["s1", "s2", "s3"], layout: "flow-right" })

    expect(overlappingPairs(session.shapes())).toEqual([])
  })

  it("ignores arrows to shapes outside the selection", () => {
    const session = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0 }),
          shape({ id: "s2", x: 300, y: 0 }),
          shape({ id: "s3", x: 600, y: 0 }),
        ],
        connections: [{ id: "s4", fromId: "s3", toId: "s1" }],
      })
    )

    // s3 is not being arranged, so its arrow must not rank s1 behind it.
    const message = session.arrangeShapes({
      ids: ["s1", "s2"],
      layout: "flow-right",
    })

    expect(message).toContain("flow-right")
    expect(message).not.toContain("overlap")
  })
})

describe("draw_diagram", () => {
  it("draws boxes and arrows in one call, with no coordinates given", () => {
    const session = createBoardSession(context())

    const message = session.drawDiagram({
      nodes: [
        { key: "client", text: "Client" },
        { key: "api", text: "API" },
        { key: "db", text: "Postgres" },
      ],
      edges: [
        { from: "client", to: "api" },
        { from: "api", to: "db", label: "writes" },
      ],
    })

    expect(message).toContain("Drew 3 shape(s) and 2 arrow(s)")
    expect(message).toContain("client=s1")
    expect(session.shapes()).toHaveLength(3)
    expect(session.connections()).toHaveLength(2)
  })

  it("emits every op in one batch, so the turn undoes as one step", () => {
    const session = createBoardSession(context())

    session.drawDiagram({
      nodes: [
        { key: "a", text: "A" },
        { key: "b", text: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    })

    expect(session.flush().map((op) => op.op)).toEqual([
      "create",
      "create",
      "connect",
    ])
  })

  it("lays the boxes out in flow order, not listing order", () => {
    const session = createBoardSession(context())

    session.drawDiagram({
      nodes: [
        { key: "c", text: "C" },
        { key: "a", text: "A" },
        { key: "b", text: "B" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    })

    const at = new Map(session.shapes().map((s) => [s.text, s]))
    expect(at.get("A")!.x).toBeLessThan(at.get("B")!.x)
    expect(at.get("B")!.x).toBeLessThan(at.get("C")!.x)
  })

  it("ranks downward when asked to", () => {
    const session = createBoardSession(context())

    session.drawDiagram({
      nodes: [
        { key: "a", text: "A" },
        { key: "b", text: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
      direction: "down",
    })

    const at = new Map(session.shapes().map((s) => [s.text, s]))
    expect(at.get("A")!.y).toBeLessThan(at.get("B")!.y)
  })

  it("never overlaps, however many boxes", () => {
    const session = createBoardSession(context())

    session.drawDiagram({
      nodes: "abcdefgh".split("").map((key) => ({ key, text: key })),
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
        { from: "d", to: "e" },
        { from: "e", to: "f" },
        { from: "e", to: "g" },
        { from: "g", to: "h" },
      ],
    })

    expect(overlappingPairs(session.shapes())).toEqual([])
  })

  it("attaches to a shape already on the board without moving it", () => {
    // "Add a cache between the API and the database" — one call.
    const session = createBoardSession(
      context({
        shapes: [
          shape({ id: "s1", x: 0, y: 0, text: "API" }),
          shape({ id: "s2", x: 400, y: 0, text: "Postgres" }),
        ],
      })
    )

    const message = session.drawDiagram({
      nodes: [{ key: "cache", text: "Redis" }],
      edges: [
        { from: "s1", to: "cache" },
        { from: "cache", to: "s2" },
      ],
    })

    expect(message).toContain("Drew 1 shape(s) and 2 arrow(s)")
    expect(session.connections().map((c) => [c.fromId, c.toId])).toEqual([
      ["s1", "s3"],
      ["s3", "s2"],
    ])
    // The user's two shapes are exactly where they were.
    const at = new Map(session.shapes().map((s) => [s.id, s]))
    expect(at.get("s1")).toMatchObject({ x: 0, y: 0 })
    expect(at.get("s2")).toMatchObject({ x: 400, y: 0 })
    expect(session.flush().some((op) => op.op === "move")).toBe(false)
  })

  it("places a new block clear of everything already drawn", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1", x: 400, y: 300, w: 600, h: 400 })] })
    )

    session.drawDiagram({
      nodes: [
        { key: "a", text: "A" },
        { key: "b", text: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    })

    expect(overlappingPairs(session.shapes())).toEqual([])
  })

  it("honours an explicit origin", () => {
    const session = createBoardSession(context())

    session.drawDiagram({ nodes: [{ key: "a", text: "A" }], x: 1000, y: 500 })

    expect(session.shapes()[0]).toMatchObject({ x: 1000, y: 500 })
  })

  it("says what an explicit origin landed on, rather than stacking quietly", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1", x: 0, y: 0, w: 400, h: 400 })] })
    )

    const message = session.drawDiagram({
      nodes: [{ key: "a", text: "A" }],
      x: 0,
      y: 0,
    })

    expect(message).toContain("s1 and s2 overlap")
    expect(message).toContain("omit x and y")
  })

  it("ranks an edge whose key was typed with a stray space", () => {
    const chainOf = (from: string) => {
      const session = createBoardSession(context())
      session.drawDiagram({
        nodes: [
          { key: "a", text: "A" },
          { key: "b", text: "B" },
          { key: "c", text: "C" },
        ],
        edges: [
          { from, to: "b" },
          { from: "b", to: "c" },
        ],
      })
      return session.shapes().map((s) => `${s.id}@${s.x},${s.y}`)
    }

    expect(chainOf("a ")).toEqual(chainOf("a"))
  })

  it("reports an arrow that names nothing, and draws the rest", () => {
    const session = createBoardSession(context())

    const message = session.drawDiagram({
      nodes: [
        { key: "a", text: "A" },
        { key: "b", text: "B" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "ghost" },
      ],
    })

    expect(message).toContain("Drew 2 shape(s) and 1 arrow(s)")
    expect(message).toContain("a -> ghost")
  })

  it("refuses no nodes, and draws a duplicated key once", () => {
    const empty = createBoardSession(context())
    expect(empty.drawDiagram({ nodes: [] })).toContain("at least one node")
    expect(empty.flush()).toEqual([])

    const duplicated = createBoardSession(context())
    duplicated.drawDiagram({
      nodes: [
        { key: "a", text: "A" },
        { key: "a", text: "Again" },
      ],
    })
    expect(duplicated.shapes()).toHaveLength(1)
  })

  it("defaults to rectangles and honours a kind where one is given", () => {
    const session = createBoardSession(context())

    session.drawDiagram({
      nodes: [
        { key: "a", text: "A" },
        { key: "b", text: "B?", kind: "diamond" },
      ],
      edges: [{ from: "a", to: "b" }],
    })

    expect(session.shapes().map((s) => s.kind)).toEqual([
      "rectangle",
      "diamond",
    ])
  })
})
