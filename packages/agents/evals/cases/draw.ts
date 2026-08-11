/**
 * Drawing something from nothing — the request the feature exists for.
 *
 * The first case is the whiteboard's own first suggestion chip, verbatim, which
 * is the right thing to be measuring: it is what a new user clicks. The other
 * three separate the axes a diagram can read along, because "left to right for
 * a pipeline, top to bottom for a hierarchy" is a rule the prompt states and
 * nothing until now checked.
 *
 * `maxLlmCalls` is the efficiency claim under test. Before `draw_diagram` a
 * six-box architecture cost six creates, six-or-more connects and a focus, each
 * its own round trip; the budgets here are set at what one planned
 * `draw_diagram` call plus a focus and a reply should cost, so a model that
 * reverts to drawing box-by-box fails on time even when the picture is fine.
 */

import type { EvalCase } from "../types.ts"
import { board } from "./support.ts"

export const DRAW_CASES: EvalCase[] = [
  {
    name: "architecture-rag-email",
    intent:
      "The suggestion chip the UI ships with. A real architecture, drawn from an empty board.",
    board: board(),
    prompt: "Draw the architecture for a RAG email system",
    expect: {
      minCreated: 5,
      labelled: true,
      flow: "right",
      maxLlmCalls: 6,
      judge:
        "Whether the diagram is a recognisable retrieval-augmented-generation email system — something that ingests or receives email, embeds or indexes it, stores those vectors, retrieves against them and generates a reply — rather than a generic three-box web app.",
    },
  },
  {
    name: "pipeline-ci",
    intent:
      "A strict left-to-right chain. Every arrow must advance, and the stages must not be reordered.",
    board: board(),
    prompt:
      "Draw our CI pipeline as a left-to-right flow: lint, then test, then build, then deploy to staging, then deploy to production.",
    expect: {
      minCreated: 5,
      labelled: true,
      flow: "right",
      edges: [
        "lint -> test",
        "test -> build",
        "build -> staging",
        "staging -> production",
      ],
      maxLlmCalls: 5,
    },
  },
  {
    name: "hierarchy-org",
    intent:
      "The other axis. A tree drawn downward, where reading order is the y axis.",
    board: board(),
    prompt:
      "Draw a top-to-bottom org chart: a CTO, with a Platform lead and a Product lead under them, and two engineers under each lead.",
    expect: {
      minCreated: 7,
      labelled: true,
      flow: "down",
      edges: ["CTO -> Platform", "CTO -> Product"],
      maxLlmCalls: 5,
    },
  },
  {
    name: "decision-retry",
    intent:
      "A branch, which is the one thing that needs a shape kind other than a rectangle — and a cycle, which the layout has to survive.",
    board: board(),
    prompt:
      "Draw the retry logic for our worker: it calls the API, checks whether the call failed, and if it did it waits and tries again, up to three times, otherwise it moves on.",
    expect: {
      minCreated: 4,
      labelled: true,
      kinds: ["diamond"],
      maxLlmCalls: 6,
      judge:
        "Whether the diagram shows a decision and a genuine loop back to the retry, rather than a straight line of boxes that merely mentions retrying in a label.",
    },
  },
]
