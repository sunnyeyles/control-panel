/**
 * "Clean this diagram up" — the second suggestion chip, and the case the new
 * flow layouts were built for.
 *
 * The board below is the failure mode the old agent produced and could not fix:
 * the right boxes and the right arrows, scattered, several of them overlapping,
 * and in an order that contradicts the arrows. Tidying it needs `arrange_shapes`
 * to read those arrows, which until `flow-right` existed it could not do — the
 * best it could manage was a row in whatever order the shapes happened to sit.
 *
 * Three properties, and the third is the one that used to go wrong: the shape
 * count is unchanged (tidying is not redrawing), nothing the user made is
 * deleted, and the overlaps are gone.
 */

import type { EvalCase } from "../types.ts"
import { arrow, board, shape } from "./support.ts"

export const CLEANUP_CASES: EvalCase[] = [
  {
    name: "tidy-messy-board",
    intent:
      "A scattered, overlapping diagram with good bones. Arrange it; do not redraw it.",
    board: board({
      shapes: [
        shape("s1", "Browser", 620, 210),
        shape("s2", "CDN", 80, 460),
        // Deliberately laid on top of s1.
        shape("s3", "API", 700, 250),
        shape("s4", "Auth", 240, 60),
        shape("s5", "Postgres", 1010, 470),
        // And these two on top of each other.
        shape("s6", "Worker", 330, 320),
        shape("s7", "Queue", 390, 360),
        shape("s8", "S3", 60, 120),
      ],
      connections: [
        arrow("s9", "s1", "s2"),
        arrow("s10", "s2", "s3"),
        arrow("s11", "s3", "s4"),
        arrow("s12", "s3", "s7"),
        arrow("s13", "s7", "s6"),
        arrow("s14", "s6", "s5"),
        arrow("s15", "s6", "s8"),
      ],
    }),
    prompt: "Clean this diagram up.",
    expect: {
      preservesShapeCount: true,
      mayDelete: [],
      flow: "right",
      maxLlmCalls: 5,
      judge:
        "Whether the same eight boxes and seven arrows are still there, now laid out so the diagram reads in the order the arrows point. Adding boxes, removing any, or leaving the layout contradicting the arrows are all failures; relabelling for clarity is not.",
    },
  },
  {
    name: "align-ragged-row",
    intent:
      "A narrower ask than a full tidy. Line them up without inventing a new layout.",
    board: board({
      shapes: [
        shape("s1", "Parse", 0, 12),
        shape("s2", "Validate", 300, 47),
        shape("s3", "Enrich", 600, 3),
        shape("s4", "Persist", 900, 61),
      ],
    }),
    prompt: "These four are not lined up. Straighten them out.",
    expect: {
      preservesShapeCount: true,
      mayDelete: [],
      callsTools: ["arrange_shapes"],
      maxLlmCalls: 4,
    },
  },
]
