/**
 * The graders are the measuring instrument, so they are tested before anything
 * they measure is trusted.
 *
 * Every case below is a turn constructed by hand — no model, no network, and
 * therefore no reason for any of this to be flaky. The assertions that matter
 * most are the *negative* ones: a grader that never fails is a grader that
 * reports success on a broken agent, which is worse than having no grader at
 * all because it comes with a number attached.
 */

import type { BoardShape, CanvasOp } from "@workspace/whiteboard-schema"
import { describe, expect, it } from "vitest"

import { board, shape } from "../cases/support.ts"
import type { EvalCase, TurnResult } from "../types.ts"
import {
  gradeAsksAQuestion,
  gradeCallsTools,
  gradeEdges,
  gradeEfficiency,
  gradeFlow,
  gradeFocus,
  gradeIdValidity,
  gradeKinds,
  gradeLabelled,
  gradeMinCreated,
  gradeMutationScope,
  gradeNoOverlap,
  gradeNoUserDamage,
  gradeShapeCount,
  gradeStructurally,
} from "./structural.ts"

function kase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    name: "test",
    intent: "test",
    board: board(),
    prompt: "draw something",
    expect: {},
    ...overrides,
  }
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    ops: [],
    toolCalls: [],
    toolReplies: [],
    reply: "",
    llmCalls: 1,
    finalShapes: [],
    finalConnections: [],
    durationMs: 0,
    ...overrides,
  }
}

const CHAIN: BoardShape[] = [
  shape("s1", "Client", 0, 0),
  shape("s2", "API", 400, 0),
  shape("s3", "Postgres", 800, 0),
]

describe("noOverlap", () => {
  it("passes a board laid out with gaps", () => {
    expect(gradeNoOverlap(kase(), turn({ finalShapes: CHAIN })).passed).toBe(
      true
    )
  })

  it("names the pair that is stacked", () => {
    const score = gradeNoOverlap(
      kase(),
      turn({ finalShapes: [shape("s1", "A", 0, 0), shape("s2", "B", 50, 50)] })
    )

    expect(score.passed).toBe(false)
    expect(score.detail).toContain("A/B")
  })

  it("ignores a text caption laid over a box", () => {
    const score = gradeNoOverlap(
      kase(),
      turn({
        finalShapes: [
          shape("s1", "A", 0, 0),
          shape("s2", "caption", 10, 10, { kind: "text" }),
        ],
      })
    )

    expect(score.passed).toBe(true)
  })
})

describe("edges", () => {
  const drawn = turn({
    finalShapes: CHAIN,
    finalConnections: [
      { id: "s4", fromId: "s1", toId: "s2" },
      { id: "s5", fromId: "s2", toId: "s3" },
    ],
  })

  it("matches on labels rather than ids", () => {
    const score = gradeEdges(
      kase({ expect: { edges: ["Client -> API", "API -> Postgres"] } }),
      drawn
    )

    expect(score.passed).toBe(true)
  })

  it("accepts a near-miss label, because a better word is not a regression", () => {
    const score = gradeEdges(
      kase({ expect: { edges: ["API -> PostgreSQL"] } }),
      drawn
    )

    expect(score.passed).toBe(true)
  })

  it("does not match a short label by coincidence — `res` is inside `Postgres`", () => {
    const score = gradeEdges(kase({ expect: { edges: ["API -> res"] } }), drawn)

    expect(score.passed).toBe(false)
  })

  it("does not accept the arrow pointing the other way", () => {
    const score = gradeEdges(
      kase({ expect: { edges: ["API -> Client"] } }),
      drawn
    )

    expect(score.passed).toBe(false)
  })

  it("gives partial credit and names what is missing", () => {
    const score = gradeEdges(
      kase({
        expect: { edges: ["Client -> API", "API -> S3", "API -> Redis"] },
      }),
      drawn
    )

    expect(score.score).toBeCloseTo(1 / 3)
    expect(score.detail).toContain("API -> S3")
    expect(score.detail).toContain("API -> Redis")
  })
})

describe("flow", () => {
  it("passes a chain that advances rightward", () => {
    const score = gradeFlow(
      kase({ expect: { flow: "right" } }),
      turn({
        finalShapes: CHAIN,
        finalConnections: [
          { id: "s4", fromId: "s1", toId: "s2" },
          { id: "s5", fromId: "s2", toId: "s3" },
        ],
      })
    )

    expect(score.passed).toBe(true)
  })

  it("fails a layout that contradicts its own arrows", () => {
    const score = gradeFlow(
      kase({ expect: { flow: "right" } }),
      turn({
        finalShapes: CHAIN,
        // Both arrows run backwards against the positions.
        finalConnections: [
          { id: "s4", fromId: "s3", toId: "s2" },
          { id: "s5", fromId: "s2", toId: "s1" },
        ],
      })
    )

    expect(score.passed).toBe(false)
    expect(score.score).toBe(0)
  })

  it("tolerates one feedback edge in an otherwise ordered diagram", () => {
    const shapes = [...CHAIN, shape("s4", "Retry", 1200, 0)]
    const score = gradeFlow(
      kase({ expect: { flow: "right" } }),
      turn({
        finalShapes: shapes,
        finalConnections: [
          { id: "c1", fromId: "s1", toId: "s2" },
          { id: "c2", fromId: "s2", toId: "s3" },
          { id: "c3", fromId: "s3", toId: "s4" },
          { id: "c4", fromId: "s4", toId: "s1" },
        ],
      })
    )

    expect(score.score).toBeCloseTo(0.75)
    // Below the threshold, so still reported — one back-edge in four is a lot.
    expect(score.passed).toBe(false)
  })

  it("fails when there is nothing to check", () => {
    expect(gradeFlow(kase({ expect: { flow: "right" } }), turn()).passed).toBe(
      false
    )
  })
})

describe("mutationScope", () => {
  const critique = kase({ expect: { mutates: false } })

  it("passes a turn that only talked", () => {
    expect(
      gradeMutationScope(critique, turn({ reply: "Looks fine." })).passed
    ).toBe(true)
  })

  it("allows a camera move, which changes nothing on the board", () => {
    const ops: CanvasOp[] = [{ op: "focus", ids: ["s1"] }]
    expect(gradeMutationScope(critique, turn({ ops })).passed).toBe(true)
  })

  it("fails a single stray box", () => {
    const ops: CanvasOp[] = [
      { op: "create", id: "s9", kind: "rectangle", x: 0, y: 0, w: 200, h: 120 },
    ]
    const score = gradeMutationScope(critique, turn({ ops }))

    expect(score.passed).toBe(false)
    expect(score.detail).toContain("create")
  })
})

describe("noUserDamage", () => {
  const existing = kase({
    board: board({
      shapes: [shape("s1", "API", 0, 0), shape("s2", "Postgres", 400, 0)],
    }),
  })

  it("passes when nothing of the user's was deleted", () => {
    expect(gradeNoUserDamage(existing, turn()).passed).toBe(true)
  })

  it("fails a delete of a shape the user drew", () => {
    const ops: CanvasOp[] = [{ op: "delete", ids: ["s1"] }]
    const score = gradeNoUserDamage(existing, turn({ ops }))

    expect(score.passed).toBe(false)
    expect(score.detail).toContain("API")
  })

  it("allows exactly what the case permitted", () => {
    const allowed = kase({
      board: existing.board,
      expect: { mayDelete: ["Postgres"] },
    })
    const ops: CanvasOp[] = [{ op: "delete", ids: ["s2"] }]

    expect(gradeNoUserDamage(allowed, turn({ ops })).passed).toBe(true)
  })

  it("does not count deleting something the turn itself created", () => {
    const ops: CanvasOp[] = [{ op: "delete", ids: ["s7"] }]
    expect(gradeNoUserDamage(existing, turn({ ops })).passed).toBe(true)
  })
})

describe("minCreated and labelled", () => {
  const drew = turn({ finalShapes: CHAIN })

  it("counts only what this turn added", () => {
    const extending = kase({
      board: board({ shapes: [shape("s1", "Client", 0, 0)] }),
      expect: { minCreated: 3 },
    })

    expect(gradeMinCreated(extending, drew).passed).toBe(false)
    expect(gradeMinCreated(extending, drew).detail).toContain("created 2")
  })

  it("fails a box with no label", () => {
    const score = gradeLabelled(
      kase({ expect: { labelled: true } }),
      turn({ finalShapes: [shape("s1", "A", 0, 0), shape("s2", "", 400, 0)] })
    )

    expect(score.passed).toBe(false)
    expect(score.score).toBeCloseTo(0.5)
  })

  it("does not demand a label on a text caption", () => {
    const score = gradeLabelled(
      kase({ expect: { labelled: true } }),
      turn({
        finalShapes: [
          shape("s1", "A", 0, 0),
          shape("s2", "", 400, 0, { kind: "text" }),
        ],
      })
    )

    expect(score.passed).toBe(true)
  })
})

describe("the smaller graders", () => {
  it("kinds looks for a shape the diagram needed", () => {
    const wants = kase({ expect: { kinds: ["diamond"] } })

    expect(gradeKinds(wants, turn({ finalShapes: CHAIN })).passed).toBe(false)
    expect(
      gradeKinds(
        wants,
        turn({
          finalShapes: [shape("s1", "Failed?", 0, 0, { kind: "diamond" })],
        })
      ).passed
    ).toBe(true)
  })

  it("callsTools checks the transcript, not the result", () => {
    const wants = kase({ expect: { callsTools: ["read_board"] } })

    expect(gradeCallsTools(wants, turn()).passed).toBe(false)
    expect(
      gradeCallsTools(
        wants,
        turn({ toolCalls: [{ name: "read_board", args: {} }] })
      ).passed
    ).toBe(true)
  })

  it("efficiency is a ceiling on model calls", () => {
    const budget = kase({ expect: { maxLlmCalls: 4 } })

    expect(gradeEfficiency(budget, turn({ llmCalls: 4 })).passed).toBe(true)
    expect(gradeEfficiency(budget, turn({ llmCalls: 5 })).passed).toBe(false)
  })

  it("idValidity reads the session's own correction", () => {
    expect(gradeIdValidity(kase(), turn()).passed).toBe(true)
    expect(
      gradeIdValidity(
        kase(),
        turn({
          toolReplies: ['There is no shape with id "s9". The board has s1.'],
        })
      ).passed
    ).toBe(false)
  })

  it("asksAQuestion wants a question mark in the reply", () => {
    const wants = kase({ expect: { asksAQuestion: true } })

    expect(
      gradeAsksAQuestion(wants, turn({ reply: "Which one do you mean?" }))
        .passed
    ).toBe(true)
    expect(
      gradeAsksAQuestion(wants, turn({ reply: "Made it bigger." })).passed
    ).toBe(false)
  })

  it("shapeCount catches a tidy-up that redrew instead", () => {
    const tidy = kase({
      board: board({ shapes: CHAIN }),
      expect: { preservesShapeCount: true },
    })

    expect(gradeShapeCount(tidy, turn({ finalShapes: CHAIN })).passed).toBe(
      true
    )
    expect(
      gradeShapeCount(tidy, turn({ finalShapes: CHAIN.slice(0, 2) })).passed
    ).toBe(false)
  })
})

describe("focus", () => {
  const offscreen = kase({
    board: board({ viewport: { x: 0, y: 0, w: 1000, h: 800 } }),
    expect: { focusesWhenOffscreen: true },
  })

  it("passes when everything drawn was already in view", () => {
    expect(
      gradeFocus(offscreen, turn({ finalShapes: [shape("s1", "A", 100, 100)] }))
        .passed
    ).toBe(true)
  })

  it("fails a diagram drawn out of sight with no camera move", () => {
    const score = gradeFocus(
      offscreen,
      turn({ finalShapes: [shape("s1", "A", 5000, 100)] })
    )

    expect(score.passed).toBe(false)
    expect(score.detail).toContain("never moved the view")
  })

  it("passes once the camera followed", () => {
    const ops: CanvasOp[] = [{ op: "focus", ids: ["s1"] }]
    expect(
      gradeFocus(
        offscreen,
        turn({ ops, finalShapes: [shape("s1", "A", 5000, 100)] })
      ).passed
    ).toBe(true)
  })
})

describe("gradeStructurally", () => {
  it("runs the three floor graders and nothing the case never asked for", () => {
    const scores = gradeStructurally(kase(), turn({ finalShapes: CHAIN }))

    expect(scores.map((score) => score.grader).sort()).toEqual([
      "idValidity",
      "noOverlap",
      "noUserDamage",
    ])

    // And the floor still fails a bare case, so it cannot be opted out of.
    const stacked = gradeStructurally(
      kase(),
      turn({ finalShapes: [shape("s1", "A", 0, 0), shape("s2", "B", 20, 20)] })
    )
    expect(stacked.find((score) => score.grader === "noOverlap")?.passed).toBe(
      false
    )
  })

  it("includes what the case did ask for", () => {
    const scores = gradeStructurally(
      kase({ expect: { minCreated: 2, labelled: true, maxLlmCalls: 3 } }),
      turn({ finalShapes: CHAIN })
    )

    expect(scores.map((score) => score.grader)).toContain("minCreated")
    expect(scores.map((score) => score.grader)).toContain("labelled")
    expect(scores.map((score) => score.grader)).toContain("efficiency")
  })
})
