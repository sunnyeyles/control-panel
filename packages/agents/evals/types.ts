/**
 * What an eval case is, and what running one produces.
 *
 * A whiteboard turn is unusually gradeable and this file is where that claim is
 * cashed in. In goes a board and a sentence; out come canvas ops, a final
 * board and a reply — all of it plain data, none of it needing a browser, a
 * screenshot or a human. So the same turn can be checked by arithmetic (did two
 * boxes overlap, did every arrow advance, was a shape the user drew deleted)
 * and only the genuinely subjective half handed to a judge.
 *
 * **An expectation is a set of questions, not a golden output.** Pinning the
 * exact diagram a model draws would fail on every rerun and teach nothing; what
 * survives rewording is the shape of the answer — this many boxes, these
 * relationships, in this reading order, without touching what the user made.
 */

import type {
  BoardConnection,
  BoardContext,
  BoardShape,
  CanvasOp,
  ShapeKind,
} from "@workspace/agent-tools/canvas-schema"

export interface EvalExpectation {
  /** At least this many shapes must be created. */
  minCreated?: number
  /**
   * Arrows that must exist, written as `"Client -> API"` and matched on shape
   * **labels**, not ids — an id is allocated per run and a label is the only
   * stable name a case can refer to. Matching is loose and case-insensitive in
   * both directions, so an expected `Postgres` is satisfied by a drawn
   * `PostgreSQL`. Direction matters: the reversed arrow does not count.
   */
  edges?: string[]
  /** Every arrow must advance along this axis, so the diagram reads in order. */
  flow?: "right" | "down"
  /**
   * `false` means the turn must not change the board at all — the critique and
   * ambiguity cases, where drawing anything is the failure.
   */
  mutates?: boolean
  /** Labels of shapes this turn is allowed to delete. Anything else is damage. */
  mayDelete?: string[]
  /** Every created box must carry a label. */
  labelled?: boolean
  /** Kinds that must appear among the created shapes, e.g. a decision diamond. */
  kinds?: ShapeKind[]
  /** Tools the turn must call at least once. */
  callsTools?: string[]
  /** New shapes outside the starting viewport must be followed by a focus. */
  focusesWhenOffscreen?: boolean
  /** Ceiling on model calls. Efficiency is a quality, not a footnote. */
  maxLlmCalls?: number
  /** The reply must put a question back to the user. */
  asksAQuestion?: boolean
  /** The starting shape count must be unchanged — a tidy-up adds and removes nothing. */
  preservesShapeCount?: boolean
  /**
   * What the judge is being asked. Omit to skip judging, which is what every
   * case that is fully covered by arithmetic should do.
   */
  judge?: string
}

export interface EvalCase {
  /** Stable, kebab-case. It is the key a baseline is diffed on. */
  name: string
  /** One line on what this case is really testing, for the report. */
  intent: string
  board: BoardContext
  prompt: string
  expect: EvalExpectation
}

/** One tool call the model made, as recorded from the transcript. */
export interface RecordedToolCall {
  name: string
  args: Record<string, unknown>
}

/** Everything one turn produced, and the whole input to grading. */
export interface TurnResult {
  ops: CanvasOp[]
  toolCalls: RecordedToolCall[]
  /** Tool replies, which is where the session's corrections show up. */
  toolReplies: string[]
  /** The assistant's final prose. */
  reply: string
  llmCalls: number
  finalShapes: BoardShape[]
  finalConnections: BoardConnection[]
  durationMs: number
}

export interface Score {
  grader: string
  /** 0 to 1. Deterministic graders are usually 0 or 1; a fraction is a partial. */
  score: number
  passed: boolean
  /** Why, in a sentence. This is what a human reads when a case regresses. */
  detail: string
  /** Set when the harness could not produce a number. Left out of the mean. */
  unscored?: boolean
}

export interface CaseResult {
  name: string
  intent: string
  repeat: number
  scores: Score[]
  /** Mean of the scores. The number a baseline diff compares. */
  overall: number
  llmCalls: number
  durationMs: number
  /** Set when the run threw. A crash is not a score of zero, it is missing data. */
  error?: string
}

export type { BoardContext }
