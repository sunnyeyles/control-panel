/**
 * Not drawing.
 *
 * An agent with a canvas and eight editing verbs is under standing pressure to
 * use them, and every case here is a request where using them is the failure.
 * Two of the three are prompt clauses with nothing behind them until now —
 * "critiquing is not editing", and asking rather than guessing at an ambiguous
 * reference — and the third is the only irreversible thing the agent can do.
 *
 * `mutates: false` is the sharp end of it: the grader counts ops, so a single
 * stray box scores zero however good the accompanying prose was.
 */

import type { EvalCase } from "../types.ts"
import { arrow, board, shape } from "./support.ts"

export const RESTRAINT_CASES: EvalCase[] = [
  {
    name: "critique-only",
    intent:
      "The third suggestion chip. An opinion was asked for; an edit was not.",
    board: board({
      shapes: [
        shape("s1", "Web app", 0, 0),
        shape("s2", "Postgres", 400, 0),
        shape("s3", "Worker", 400, 300),
      ],
      connections: [
        arrow("s4", "s1", "s2"),
        arrow("s5", "s3", "s2"),
        arrow("s6", "s1", "s3"),
      ],
    }),
    prompt: "What is wrong with this architecture?",
    expect: {
      mutates: false,
      maxLlmCalls: 3,
      judge:
        "Whether the critique names something specific and true about this particular diagram — the single database as a shared bottleneck, the missing queue between the app and the worker, the absence of any cache or failure path — rather than reciting generic architecture advice that would fit any drawing.",
    },
  },
  {
    name: "ambiguous-reference",
    intent:
      "Two boxes match the description and nothing is selected. Guessing edits the wrong one.",
    board: board({
      shapes: [
        shape("s1", "API", 0, 0),
        shape("s2", "API", 400, 300),
        shape("s3", "Postgres", 800, 0),
      ],
    }),
    prompt: "Make the API box bigger.",
    expect: {
      mutates: false,
      asksAQuestion: true,
      maxLlmCalls: 3,
    },
  },
  {
    name: "delete-scoped",
    intent:
      "The one irreversible verb. Exactly the named box goes, and nothing else.",
    board: board({
      shapes: [
        shape("s1", "API", 0, 0),
        shape("s2", "Postgres", 400, 0),
        shape("s3", "Worker", 400, 300),
      ],
      connections: [arrow("s4", "s1", "s2"), arrow("s5", "s3", "s2")],
    }),
    prompt: "Delete the database.",
    expect: {
      mayDelete: ["Postgres"],
      maxLlmCalls: 3,
      judge:
        "Whether exactly the Postgres box was removed. The API and the Worker must both still be on the board; their arrows to the deleted box going with it is correct, not damage.",
    },
  },
  {
    name: "answer-without-drawing",
    intent: "A question about the board is a question, not a drawing request.",
    board: board({
      shapes: [
        shape("s1", "Client", 0, 0),
        shape("s2", "API", 300, 0),
        shape("s3", "Postgres", 600, 0),
      ],
      connections: [arrow("s4", "s1", "s2"), arrow("s5", "s2", "s3")],
    }),
    prompt: "Which box does the client talk to?",
    expect: {
      mutates: false,
      maxLlmCalls: 3,
      judge:
        "Whether the reply says the client talks to the API, reading it off the arrow that is actually on the board.",
    },
  },
]
