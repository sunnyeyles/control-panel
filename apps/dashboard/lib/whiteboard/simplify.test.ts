import { describe, expect, it } from "vitest"

import {
  MAX_DETAILED_SHAPES,
  plainText,
  toBoardContext,
  toSimpleId,
  type BindingLike,
  type Bounds,
  type ShapeLike,
  type ToBoardContextInput,
} from "./simplify"

/** tldraw's rich text: a ProseMirror document. */
function rich(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  }
}

function geo(
  id: string,
  overrides: {
    x?: number
    y?: number
    geo?: string
    text?: string
    color?: string
  } = {}
): ShapeLike {
  return {
    id: `shape:${id}`,
    type: "geo",
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    props: {
      geo: overrides.geo ?? "rectangle",
      ...(overrides.text ? { richText: rich(overrides.text) } : {}),
      ...(overrides.color ? { color: overrides.color } : {}),
    },
  }
}

function boundsFor(shapes: ShapeLike[], size = { w: 200, h: 120 }) {
  const map = new Map<string, Bounds>()
  for (const shape of shapes) {
    map.set(shape.id, { x: shape.x, y: shape.y, w: size.w, h: size.h })
  }
  return map
}

function input(
  shapes: ShapeLike[],
  overrides: Partial<ToBoardContextInput> = {}
): ToBoardContextInput {
  return {
    shapes,
    bindings: [],
    boundsById: boundsFor(shapes),
    selection: [],
    viewport: { x: 0, y: 0, w: 1200, h: 800 },
    ...overrides,
  }
}

describe("ids", () => {
  it("strips tldraw's prefix, and leaves an already-short id alone", () => {
    expect(toSimpleId("shape:s7")).toBe("s7")
    expect(toSimpleId("s7")).toBe("s7")
  })
})

describe("labels", () => {
  it("reads the words out of a rich-text document", () => {
    expect(plainText(rich("Vector store"))).toBe("Vector store")
  })

  it("joins across nested nodes and collapses the whitespace", () => {
    expect(
      plainText({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Ingest " }] },
          { type: "paragraph", content: [{ type: "text", text: " worker" }] },
        ],
      })
    ).toBe("Ingest worker")
  })

  it("degrades to empty rather than throwing on something unexpected", () => {
    expect(plainText(undefined)).toBe("")
    expect(plainText("just a string")).toBe("")
  })
})

describe("shapes", () => {
  it("sends position, size, label and colour, and nothing else", () => {
    const shapes = [geo("s1", { x: 10, y: 20, text: "API", color: "blue" })]

    expect(toBoardContext(input(shapes)).shapes).toEqual([
      {
        id: "s1",
        kind: "rectangle",
        x: 10,
        y: 20,
        w: 200,
        h: 120,
        text: "API",
        color: "blue",
      },
    ])
  })

  it("takes size from the page bounds, not from props", () => {
    // A note has no width of its own; only the bounds know how big it is.
    const note: ShapeLike = {
      id: "shape:s1",
      type: "note",
      x: 0,
      y: 0,
      props: { richText: rich("todo") },
    }
    const boundsById = new Map([["shape:s1", { x: 0, y: 0, w: 320, h: 320 }]])

    expect(
      toBoardContext(input([note], { boundsById })).shapes[0]
    ).toMatchObject({ kind: "note", w: 320, h: 320 })
  })

  it("maps a geo value the vocabulary has no word for onto rectangle", () => {
    const shapes = [geo("s1", { geo: "star" })]

    expect(toBoardContext(input(shapes)).shapes[0]?.kind).toBe("rectangle")
  })

  it("rounds coordinates, because a fraction of a pixel helps nobody", () => {
    const shapes = [geo("s1")]
    const boundsById = new Map([
      ["shape:s1", { x: 10.4, y: -20.6, w: 200.5, h: 120.2 }],
    ])

    expect(
      toBoardContext(input(shapes, { boundsById })).shapes[0]
    ).toMatchObject({ x: 10, y: -21, w: 201, h: 120 })
  })

  it("omits a shape tldraw could not measure rather than guessing at it", () => {
    const shapes = [geo("s1"), geo("s2")]
    const boundsById = boundsFor([geo("s1")])

    expect(toBoardContext(input(shapes, { boundsById })).shapes).toHaveLength(1)
  })
})

describe("connections", () => {
  const from = geo("s1", { x: 0, y: 0 })
  const to = geo("s2", { x: 400, y: 0 })
  const arrow: ShapeLike = {
    id: "shape:s3",
    type: "arrow",
    x: 0,
    y: 0,
    props: { richText: rich("writes") },
  }

  function binding(terminal: "start" | "end", toId: string): BindingLike {
    return {
      id: `binding:${terminal}`,
      type: "arrow",
      fromId: "shape:s3",
      toId,
      props: { terminal },
    }
  }

  it("reports a bound arrow as a connection, with its label", () => {
    const board = toBoardContext(
      input([from, to, arrow], {
        boundsById: boundsFor([from, to]),
        bindings: [binding("start", "shape:s1"), binding("end", "shape:s2")],
      })
    )

    expect(board.connections).toEqual([
      { id: "s3", fromId: "s1", toId: "s2", label: "writes" },
    ])
  })

  it("never reports an arrow as a shape, so the model cannot try to move one", () => {
    const board = toBoardContext(
      input([from, to, arrow], {
        boundsById: boundsFor([from, to]),
        bindings: [binding("start", "shape:s1"), binding("end", "shape:s2")],
      })
    )

    expect(board.shapes.map((shape) => shape.id)).toEqual(["s1", "s2"])
  })

  it("drops a loose arrow, which connects nothing the model could name", () => {
    const board = toBoardContext(
      input([from, to, arrow], { boundsById: boundsFor([from, to]) })
    )

    expect(board.connections).toEqual([])
  })

  it("drops a half-bound arrow for the same reason", () => {
    const board = toBoardContext(
      input([from, to, arrow], {
        boundsById: boundsFor([from, to]),
        bindings: [binding("start", "shape:s1")],
      })
    )

    expect(board.connections).toEqual([])
  })
})

describe("the cap", () => {
  function many(count: number, x: number): ShapeLike[] {
    return Array.from({ length: count }, (_, index) =>
      geo(`n${x}-${index}`, { x, y: index * 200 })
    )
  }

  it("keeps everything, and says nothing about offscreen, under the cap", () => {
    const shapes = many(10, 0)

    expect(toBoardContext(input(shapes)).offscreen).toBeUndefined()
  })

  it("prefers what the user is looking at when it has to choose", () => {
    // 80 far away, then 5 in view. The near ones must survive the cap.
    const far = many(MAX_DETAILED_SHAPES, 90_000)
    const near = many(5, 0)
    const shapes = [...far, ...near]

    const board = toBoardContext(
      input(shapes, { boundsById: boundsFor(shapes) })
    )

    expect(board.shapes).toHaveLength(MAX_DETAILED_SHAPES)
    for (const shape of near) {
      expect(board.shapes.some((s) => s.id === toSimpleId(shape.id))).toBe(true)
    }
  })

  it("summarises what it dropped, with a count and a box", () => {
    const shapes = [...many(5, 0), ...many(MAX_DETAILED_SHAPES, 90_000)]

    const board = toBoardContext(
      input(shapes, { boundsById: boundsFor(shapes) })
    )

    expect(board.offscreen).toEqual({
      count: 5,
      bounds: expect.objectContaining({ x: 90_000 }),
    })
  })
})

describe("reference signals", () => {
  it("passes selection and recent edits through as short ids", () => {
    const shapes = [geo("s1"), geo("s2")]

    const board = toBoardContext(
      input(shapes, {
        selection: ["shape:s1"],
        recentEdits: ["shape:s2"],
      })
    )

    expect(board.selection).toEqual(["s1"])
    expect(board.recentEdits).toEqual(["s2"])
  })

  it("drops a reference to a shape it did not describe", () => {
    // Telling the model something is selected without showing it what that is
    // guarantees a tool call that gets corrected.
    const shapes = [geo("s1")]

    const board = toBoardContext(
      input(shapes, { selection: ["shape:s1", "shape:gone"] })
    )

    expect(board.selection).toEqual(["s1"])
  })

  it("carries last turn's failures forward when there are any", () => {
    expect(
      toBoardContext(
        input([geo("s1")], { lastTurnErrors: ["move on s4: gone"] })
      ).lastTurnErrors
    ).toEqual(["move on s4: gone"])
  })

  it("omits the failures field entirely when the last turn was clean", () => {
    expect(toBoardContext(input([geo("s1")])).lastTurnErrors).toBeUndefined()
  })
})
