/**
 * The graders that cost nothing and catch most of it.
 *
 * Every function here is pure over `(EvalCase, TurnResult)`, which is why they
 * have an ordinary vitest suite that runs in `pnpm test` alongside the rest of
 * the repo. **The harness that spends money is not the part that has to be
 * right; this is.** A judge that mis-scores one case in ten is tolerable noise.
 * A grader that reports "no overlap" when two boxes are stacked would make
 * every number downstream a lie, so it is tested like production code.
 *
 * Two conventions run through them:
 *
 * - **Labels, never ids.** Ids are allocated per run, so a case that named one
 *   would be asserting on an implementation detail that legitimately changes.
 *   A label is what the user reads and what a case can stably ask for.
 * - **Partial credit where partial credit is real.** "Six of the seven arrows
 *   you asked for" is genuinely better than three, and a binary pass would
 *   throw away the only signal that says whether a change helped.
 */

import type { BoardShape, CanvasOp } from "@workspace/whiteboard-schema"

import type { EvalCase, Score, TurnResult } from "../types.ts"

/** Ops that change what the user sees. A focus moves the camera, not the board. */
const MUTATING_OPS = new Set(["create", "update", "move", "delete", "connect"])

/** Below this a flow is not reading in order, it is a pile with arrows. */
const FLOW_THRESHOLD = 0.85

/**
 * A grader the case did not ask for.
 *
 * It reports a pass so nothing downstream has to special-case it, and
 * {@link gradeStructurally} then drops it — a case's score is the mean of the
 * questions it actually posed, not of a dozen it never did. The sentinel is a
 * constant rather than a repeated string so the filter cannot drift from the
 * thing it filters on.
 */
const NOT_CHECKED = "not checked"

function ok(grader: string, detail: string): Score {
  return { grader, score: 1, passed: true, detail }
}

function bad(grader: string, detail: string): Score {
  return { grader, score: 0, passed: false, detail }
}

function partial(
  grader: string,
  score: number,
  threshold: number,
  detail: string
): Score {
  return { grader, score, passed: score >= threshold, detail }
}

/**
 * Loose label matching, in both directions.
 *
 * A case asks for `Postgres` and the model draws `PostgreSQL`; asks for `Cache`
 * and gets `Redis Cache`. Both are the box the case meant, and a grader strict
 * enough to reject them would report a regression every time the model chose a
 * better word. Punctuation and spacing go, then either string containing the
 * other is a match — but only once the shorter side is long enough to mean
 * something. Below that, containment is coincidence: `API` is inside `Rapid`.
 */
const MIN_SUBSTRING_LENGTH = 4
function normalise(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function labelsMatch(expected: string, actual: string): boolean {
  const a = normalise(expected)
  const b = normalise(actual)
  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true
  if (Math.min(a.length, b.length) < MIN_SUBSTRING_LENGTH) return false
  return a.includes(b) || b.includes(a)
}

function isMutating(op: CanvasOp): boolean {
  return MUTATING_OPS.has(op.op)
}

function createdShapes(kase: EvalCase, result: TurnResult): BoardShape[] {
  const before = new Set(kase.board.shapes.map((shape) => shape.id))
  return result.finalShapes.filter((shape) => !before.has(shape.id))
}

/** Boxes only. A caption is allowed to have no label and to sit over things. */
function isBox(shape: { kind: string }): boolean {
  return shape.kind !== "text"
}

export function gradeMinCreated(kase: EvalCase, result: TurnResult): Score {
  const wanted = kase.expect.minCreated
  if (wanted === undefined) return ok("minCreated", NOT_CHECKED)

  const made = createdShapes(kase, result).filter(isBox).length
  return made >= wanted
    ? ok("minCreated", `created ${made}, wanted at least ${wanted}`)
    : bad("minCreated", `created ${made}, wanted at least ${wanted}`)
}

export function gradeNoOverlap(_kase: EvalCase, result: TurnResult): Score {
  const boxes = result.finalShapes.filter(isBox)
  const clashes: string[] = []

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      if (!a || !b) continue
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        clashes.push(`${a.text ?? a.id}/${b.text ?? b.id}`)
      }
    }
  }

  return clashes.length === 0
    ? ok("noOverlap", `${boxes.length} shapes, none overlapping`)
    : bad(
        "noOverlap",
        `${clashes.length} overlapping pair(s): ${clashes.join(", ")}`
      )
}

export function gradeEdges(kase: EvalCase, result: TurnResult): Score {
  const wanted = kase.expect.edges ?? []
  if (wanted.length === 0) return ok("edges", NOT_CHECKED)

  const labelOf = (id: string): string =>
    result.finalShapes.find((shape) => shape.id === id)?.text ?? id

  const drawn = result.finalConnections.map((connection) => ({
    from: labelOf(connection.fromId),
    to: labelOf(connection.toId),
  }))

  const missing: string[] = []
  for (const edge of wanted) {
    const [from = "", to = ""] = edge.split("->").map((part) => part.trim())
    const found = drawn.some(
      (actual) => labelsMatch(from, actual.from) && labelsMatch(to, actual.to)
    )
    if (!found) missing.push(edge)
  }

  const score = (wanted.length - missing.length) / wanted.length
  return partial(
    "edges",
    score,
    1,
    missing.length === 0
      ? `all ${wanted.length} arrows drawn`
      : `missing ${missing.length}/${wanted.length}: ${missing.join(", ")}`
  )
}

/**
 * Does the diagram read in the order it runs?
 *
 * A fraction rather than a yes, and the threshold is below 1 on purpose: a
 * feedback edge or a retry loop genuinely points backwards, and a diagram is
 * not wrong for containing one. What this catches is the layout that ignores
 * its arrows altogether, where the fraction collapses rather than dips.
 */
export function gradeFlow(kase: EvalCase, result: TurnResult): Score {
  const axis = kase.expect.flow
  if (!axis) return ok("flow", NOT_CHECKED)

  const at = new Map(result.finalShapes.map((shape) => [shape.id, shape]))
  const pairs = result.finalConnections
    .map((connection) => ({
      from: at.get(connection.fromId),
      to: at.get(connection.toId),
    }))
    .filter((pair) => pair.from && pair.to)

  if (pairs.length === 0) return bad("flow", "no arrows to check")

  const advancing = pairs.filter((pair) =>
    axis === "right" ? pair.from!.x < pair.to!.x : pair.from!.y < pair.to!.y
  ).length

  const score = advancing / pairs.length
  return partial(
    "flow",
    score,
    FLOW_THRESHOLD,
    `${advancing}/${pairs.length} arrows advance ${axis === "right" ? "rightward" : "downward"}`
  )
}

export function gradeMutationScope(kase: EvalCase, result: TurnResult): Score {
  if (kase.expect.mutates !== false) return ok("mutationScope", NOT_CHECKED)

  const changed = result.ops.filter(isMutating)
  return changed.length === 0
    ? ok("mutationScope", "left the board alone, as asked")
    : bad(
        "mutationScope",
        `made ${changed.length} change(s) when it should have made none: ${changed
          .map((op) => op.op)
          .join(", ")}`
      )
}

/**
 * Did it destroy something the user drew?
 *
 * The most serious failure the agent has, because it is the only one an undo is
 * needed to recover from — so it is graded against the *starting* board rather
 * than against anything the turn itself created.
 */
export function gradeNoUserDamage(kase: EvalCase, result: TurnResult): Score {
  const owned = new Map(
    kase.board.shapes.map((shape) => [shape.id, shape.text ?? shape.id])
  )
  const allowed = kase.expect.mayDelete ?? []

  const wrongful: string[] = []
  for (const op of result.ops) {
    if (op.op !== "delete") continue
    for (const id of op.ids) {
      const label = owned.get(id)
      if (label === undefined) continue
      if (allowed.some((name) => labelsMatch(name, label))) continue
      wrongful.push(label)
    }
  }

  return wrongful.length === 0
    ? ok("noUserDamage", "deleted nothing it should not have")
    : bad("noUserDamage", `deleted the user's ${wrongful.join(", ")}`)
}

export function gradeLabelled(kase: EvalCase, result: TurnResult): Score {
  if (!kase.expect.labelled) return ok("labelled", NOT_CHECKED)

  const made = createdShapes(kase, result).filter(isBox)
  if (made.length === 0) return bad("labelled", "created nothing to label")

  const blank = made.filter((shape) => !shape.text || shape.text.trim() === "")
  const score = (made.length - blank.length) / made.length
  return partial(
    "labelled",
    score,
    1,
    blank.length === 0
      ? `all ${made.length} boxes labelled`
      : `${blank.length}/${made.length} boxes have no label`
  )
}

export function gradeKinds(kase: EvalCase, result: TurnResult): Score {
  const wanted = kase.expect.kinds ?? []
  if (wanted.length === 0) return ok("kinds", NOT_CHECKED)

  const made = new Set(createdShapes(kase, result).map((shape) => shape.kind))
  const missing = wanted.filter((kind) => !made.has(kind))
  const score = (wanted.length - missing.length) / wanted.length

  return partial(
    "kinds",
    score,
    1,
    missing.length === 0
      ? `drew ${wanted.join(", ")}`
      : `never drew ${missing.join(", ")}`
  )
}

export function gradeCallsTools(kase: EvalCase, result: TurnResult): Score {
  const wanted = kase.expect.callsTools ?? []
  if (wanted.length === 0) return ok("callsTools", NOT_CHECKED)

  const called = new Set(result.toolCalls.map((call) => call.name))
  const missing = wanted.filter((name) => !called.has(name))
  const score = (wanted.length - missing.length) / wanted.length

  return partial(
    "callsTools",
    score,
    1,
    missing.length === 0
      ? `called ${wanted.join(", ")}`
      : `never called ${missing.join(", ")}`
  )
}

/**
 * A shape drawn where the user cannot see it, with no camera move after it.
 *
 * Only fires when the turn actually drew off screen — an agent that placed
 * everything in view is not owed a `focus_viewport`, and demanding one would
 * train it to jog the camera for no reason.
 */
export function gradeFocus(kase: EvalCase, result: TurnResult): Score {
  if (!kase.expect.focusesWhenOffscreen) return ok("focus", NOT_CHECKED)

  const view = kase.board.viewport
  const offscreen = createdShapes(kase, result).filter(
    (shape) =>
      shape.x + shape.w < view.x ||
      shape.x > view.x + view.w ||
      shape.y + shape.h < view.y ||
      shape.y > view.y + view.h
  )

  if (offscreen.length === 0) {
    return ok("focus", "everything it drew was already in view")
  }

  return result.ops.some((op) => op.op === "focus")
    ? ok("focus", `moved the view after drawing ${offscreen.length} off screen`)
    : bad(
        "focus",
        `drew ${offscreen.length} shape(s) off screen and never moved the view`
      )
}

export function gradeEfficiency(kase: EvalCase, result: TurnResult): Score {
  const ceiling = kase.expect.maxLlmCalls
  if (ceiling === undefined) return ok("efficiency", NOT_CHECKED)

  return result.llmCalls <= ceiling
    ? ok("efficiency", `${result.llmCalls} model call(s), budget ${ceiling}`)
    : bad("efficiency", `${result.llmCalls} model call(s), budget ${ceiling}`)
}

/**
 * Did the model name a shape that does not exist?
 *
 * Read off the session's own corrections rather than re-derived here. The
 * board session already answers an unknown id with a sentence saying so, and
 * trusting that is both simpler and exactly the signal the model itself got.
 */
export function gradeIdValidity(_kase: EvalCase, result: TurnResult): Score {
  const invented = result.toolReplies.filter((reply) =>
    /there is no shape with id/i.test(reply)
  )

  return invented.length === 0
    ? ok("idValidity", "every id it used existed")
    : bad("idValidity", `invented ${invented.length} id(s)`)
}

export function gradeAsksAQuestion(kase: EvalCase, result: TurnResult): Score {
  if (!kase.expect.asksAQuestion) return ok("asksAQuestion", NOT_CHECKED)

  return result.reply.includes("?")
    ? ok("asksAQuestion", "asked rather than guessed")
    : bad("asksAQuestion", `did not ask: "${result.reply.slice(0, 120)}"`)
}

export function gradeShapeCount(kase: EvalCase, result: TurnResult): Score {
  if (!kase.expect.preservesShapeCount) return ok("shapeCount", NOT_CHECKED)

  const before = kase.board.shapes.length
  const after = result.finalShapes.length
  return before === after
    ? ok("shapeCount", `still ${after} shapes`)
    : bad("shapeCount", `started with ${before} shapes and ended with ${after}`)
}

const GRADERS = [
  gradeMinCreated,
  gradeNoOverlap,
  gradeEdges,
  gradeFlow,
  gradeMutationScope,
  gradeNoUserDamage,
  gradeLabelled,
  gradeKinds,
  gradeCallsTools,
  gradeFocus,
  gradeEfficiency,
  gradeIdValidity,
  gradeAsksAQuestion,
  gradeShapeCount,
] as const

/**
 * The three that run whether or not a case asked for them.
 *
 * They are not case-specific questions, they are the floor: no turn should
 * leave boxes stacked, destroy something the user drew, or name a shape that
 * does not exist. A case cannot opt out, because a case that wanted to would be
 * asserting the agent may do one of those things.
 */
const ALWAYS: ReadonlySet<string> = new Set([
  "noOverlap",
  "noUserDamage",
  "idValidity",
])

/**
 * Every structural grader a case opted into, plus {@link ALWAYS}.
 *
 * Graders the case said nothing about report {@link NOT_CHECKED} and are
 * dropped here, so its score is the mean of the questions it actually posed
 * rather than being diluted by a dozen it never did.
 */
export function gradeStructurally(kase: EvalCase, result: TurnResult): Score[] {
  return GRADERS.map((grader) => grader(kase, result)).filter(
    (score) => ALWAYS.has(score.grader) || score.detail !== NOT_CHECKED
  )
}
