import { describe, expect, it } from "vitest"

import { createBoardSession } from "./board-session.ts"
import type { BoardContext, BoardShape } from "./canvas-schema.ts"

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

  it("does not collide with an arrow's id, since arrows are shapes too", () => {
    const session = createBoardSession(
      context({
        shapes: [shape({ id: "s1" }), shape({ id: "s2" })],
        connections: [{ id: "s3", fromId: "s1", toId: "s2" }],
      })
    )

    session.createShape({ kind: "rectangle", x: 0, y: 0 })

    expect(session.shapes().at(-1)?.id).toBe("s4")
  })

  it("never reuses the id of a shape the user drew by hand", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "Xk3p9vQ2" })] })
    )

    expect(session.createShape({ kind: "note", x: 0, y: 0 })).toContain("s1")
  })

  it("skips an id the board describes nowhere but `knownIds` reports", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" })], knownIds: ["s1", "s2", "s3"] })
    )

    session.createShape({ kind: "rectangle", x: 0, y: 0 })

    expect(session.shapes().at(-1)?.id).toBe("s4")
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

  it("refuses to connect a shape to itself", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" })] })
    )

    expect(session.connectShapes({ fromId: "s1", toId: "s1" })).toContain(
      "itself"
    )
    expect(session.flush()).toEqual([])
  })

  it("says what to pass when an update would change nothing", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" })] })
    )

    expect(session.updateShape({ id: "s1" })).toContain("at least one of")
  })

  it("deletes what it can and names what it could not", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s2" })] })
    )

    const message = session.deleteShapes(["s1", "s9"])

    expect(message).toContain("Deleted s1")
    expect(message).toContain("No shape matched s9")
    expect(session.flush()).toEqual([{ op: "delete", ids: ["s1"] }])
  })

  it("treats a repeated id as one deletion, not a deletion and a miss", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s2" })] })
    )

    // The second spelling must not come back as "No shape matched" — a
    // correction that contradicts the deletion beside it.
    const message = session.deleteShapes(["s1", "shape:s1"])

    expect(message).toContain("Deleted s1")
    expect(message).not.toContain("No shape matched")
    expect(session.flush()).toEqual([{ op: "delete", ids: ["s1"] }])
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

  it("lists the arrows too when it deleted nothing at all", () => {
    const session = createBoardSession(
      context({
        shapes: [shape({ id: "s1" }), shape({ id: "s2" })],
        connections: [{ id: "s3", fromId: "s1", toId: "s2" }],
      })
    )

    expect(session.deleteShapes(["s9"])).toContain("s1, s2, s3")
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

  it("will not distribute two shapes, because there is no space to even out", () => {
    const session = createBoardSession(three)

    expect(
      session.arrangeShapes({
        ids: ["s1", "s2"],
        layout: "distribute-horizontal",
      })
    ).toContain("at least three")
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

  it("needs two shapes that exist before it will arrange anything", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" })] })
    )

    expect(
      session.arrangeShapes({ ids: ["s1", "s9"], layout: "row" })
    ).toContain("at least two shapes that exist")
  })

  it("counts a repeated id once, so one shape named twice is not two", () => {
    const session = createBoardSession(
      context({ shapes: [shape({ id: "s1" }), shape({ id: "s2" })] })
    )

    // Same shape, two spellings — the guards count shapes, not spellings.
    expect(
      session.arrangeShapes({ ids: ["s1", "shape:s1"], layout: "row" })
    ).toContain("at least two shapes that exist")
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
