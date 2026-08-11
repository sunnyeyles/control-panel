/**
 * Knowing what it cannot see, and what went wrong last turn.
 *
 * Two channels in `BoardContext` exist purely for these situations and are
 * otherwise never exercised: `offscreen`, which tells the model the board
 * continues past what it was shown so it does not conclude the canvas is empty
 * out there, and `lastTurnErrors`, which carries the ops the browser could not
 * apply and arrives a turn late because that is when the model can act on them.
 *
 * Both are the kind of thing that decays silently. Nothing breaks if the model
 * starts ignoring them; the answers just quietly become wrong.
 */

import type { EvalCase } from "../types.ts"
import { arrow, board, shape } from "./support.ts"

export const AWARENESS_CASES: EvalCase[] = [
  {
    name: "offscreen-count",
    intent:
      "A question about the whole board, when most of the board was not sent. read_board is the only way to answer it.",
    board: board({
      shapes: [
        shape("s1", "Client", 100, 100),
        shape("s2", "API", 400, 100),
        shape("s3", "Postgres", 700, 100),
      ],
      connections: [arrow("s4", "s1", "s2"), arrow("s5", "s2", "s3")],
      offscreen: { count: 12, bounds: { x: 2000, y: -400, w: 1800, h: 1400 } },
    }),
    prompt: "How many boxes are on this board altogether?",
    expect: {
      mutates: false,
      callsTools: ["read_board"],
      maxLlmCalls: 4,
      judge:
        "Whether the answer accounts for the shapes outside the view rather than replying with only the three it was shown. The board description says twelve more exist; an answer of 3 is wrong and an answer that acknowledges roughly fifteen, or that says it checked, is right.",
    },
  },
  {
    name: "draws-offscreen-then-focuses",
    intent:
      "A new diagram placed away from a crowded viewport has to be followed by a camera move, or the user sees nothing happen.",
    board: board({
      shapes: [shape("s1", "Existing", 0, 0, { w: 1400, h: 900 })],
      viewport: { x: 0, y: 0, w: 1400, h: 900 },
    }),
    prompt:
      "Draw a separate three-step diagram beside this: collect, transform, publish.",
    expect: {
      minCreated: 3,
      labelled: true,
      focusesWhenOffscreen: true,
      mayDelete: [],
      maxLlmCalls: 5,
    },
  },
  {
    name: "recovers-from-last-turn-error",
    intent:
      "The board says a change did not land. Repeating it verbatim is the failure.",
    board: board({
      shapes: [shape("s1", "API", 0, 0), shape("s2", "Postgres", 400, 0)],
      connections: [arrow("s3", "s1", "s2")],
      lastTurnErrors: [
        'move s9: no shape with that id existed on the canvas, so "Cache" was never placed',
      ],
    }),
    prompt: "That did not work — try again.",
    expect: {
      maxLlmCalls: 6,
      judge:
        "Whether the assistant took the reported failure seriously — either re-creating the missing Cache box properly, or saying plainly what it could not do — rather than repeating the same doomed move or claiming success without changing anything.",
    },
  },
]
