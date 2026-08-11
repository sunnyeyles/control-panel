/**
 * Changing a board that already has something on it.
 *
 * Harder than drawing from empty and more common in real use, because every one
 * of these turns on resolving a reference — "between them", "this", "what I
 * just drew" — against the four soft signals the board carries. The prompt puts
 * those in a strict order (selection, recent edits, labels, viewport) and this
 * is where that order is actually exercised.
 */

import type { EvalCase } from "../types.ts"
import { arrow, board, shape } from "./support.ts"

export const EDIT_CASES: EvalCase[] = [
  {
    name: "insert-cache",
    intent:
      "Insert a node into an existing edge and rewire it. One draw_diagram call can do the whole thing.",
    board: board({
      shapes: [shape("s1", "API", 0, 0), shape("s2", "Postgres", 600, 0)],
      connections: [arrow("s3", "s1", "s2", "queries")],
    }),
    prompt: "Add a Redis cache between the API and the database.",
    expect: {
      minCreated: 1,
      labelled: true,
      edges: ["API -> Redis", "Redis -> Postgres"],
      // The two boxes that were already there must survive the operation.
      mayDelete: [],
      maxLlmCalls: 6,
      judge:
        "Whether the cache genuinely sits between the API and the database — reachable from the API and reaching the database — rather than being hung off to one side while the original direct arrow still carries the traffic.",
    },
  },
  {
    name: "recolour-selection",
    intent:
      'Selection is the strongest reference signal. "This" must mean the selected box and only it.',
    board: board({
      shapes: [
        shape("s1", "Ingest", 0, 0),
        shape("s2", "Embed", 300, 0),
        shape("s3", "Store", 600, 0),
      ],
      selection: ["s2"],
    }),
    prompt: "Make this one red.",
    expect: {
      preservesShapeCount: true,
      mayDelete: [],
      maxLlmCalls: 3,
      judge:
        "Whether exactly the selected box (Embed) became red and the other two were left alone. Changing all three, or the wrong one, is a failure however tidy the result.",
    },
  },
  {
    name: "connect-recent",
    intent:
      '"What I just drew" resolves through recentEdits, which is the only place that information exists.',
    board: board({
      shapes: [
        shape("s1", "API", 0, 0),
        shape("s2", "Worker", 300, 300),
        shape("s3", "Metrics", 700, 300),
      ],
      recentEdits: ["s3"],
    }),
    prompt: "Connect what I just drew to the API.",
    expect: {
      preservesShapeCount: true,
      edges: ["Metrics -> API"],
      mayDelete: [],
      maxLlmCalls: 3,
    },
  },
  {
    name: "relabel-by-name",
    intent:
      "No selection and no recent edit, so the reference has to come from the labels themselves.",
    board: board({
      shapes: [
        shape("s1", "Frontend", 0, 0),
        shape("s2", "Backend", 300, 0),
        shape("s3", "Datbase", 600, 0),
      ],
      connections: [arrow("s4", "s1", "s2"), arrow("s5", "s2", "s3")],
    }),
    prompt: 'The last box is spelled wrong — it should be "Database".',
    expect: {
      preservesShapeCount: true,
      mayDelete: [],
      maxLlmCalls: 3,
      judge:
        'Whether the misspelled box now reads "Database" and nothing else on the board changed.',
    },
  },
]
