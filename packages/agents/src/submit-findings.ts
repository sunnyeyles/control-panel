import { tool, type StructuredToolInterface } from "@langchain/core/tools"

import { ScoutFindingsSchema, type ScoutFindings } from "./findings.ts"

/**
 * How the scout hands over what it found.
 *
 * The hand-off used to be JSON in the scout's final message, parsed and
 * validated by the worker. That put the one structured artefact of the run
 * behind the one channel with no structure: a stray sentence before the brace, a
 * code fence, a trailing comma, and a run that had searched successfully and
 * found real postings failed anyway.
 *
 * A tool call moves the validation to the provider. {@link ScoutFindingsSchema}
 * is the tool's argument schema, so a model that gets the shape wrong is told so
 * in a tool result and gets to correct it inside the same run — and the prompt
 * no longer has to carry a rendered JSON Schema for it to ignore.
 *
 * ⚠️ **The findings are captured here, not read out of the transcript.** They
 * are taken after the schema has accepted them, which is the only place the
 * validated value exists — the raw arguments on the AI message are pre-
 * validation, and re-parsing them downstream would be validating twice and
 * trusting the second one. The consequence worth having: a scout that submits
 * and then exhausts its model-call budget still hands over its findings, where
 * the old arrangement needed a clean final message and lost everything without
 * one.
 */

export interface SubmitFindings {
  tool: StructuredToolInterface
  /**
   * What the scout submitted, or `undefined` if it never did.
   *
   * `undefined` is a real outcome and the caller must decide what it means — a
   * scout that searched and never reported has not produced an empty result, it
   * has produced no result.
   */
  submitted(): ScoutFindings | undefined
}

/**
 * Build the tool and a handle on what it captures.
 *
 * One per run, like the posting catalog it reports against, because the capture
 * is per-run state. A module-level instance would carry one run's findings into
 * the next.
 */
export function createSubmitFindings(): SubmitFindings {
  let findings: ScoutFindings | undefined

  return {
    tool: tool(
      async (input: ScoutFindings) => {
        // Last submission wins. A model that reports, notices it left something
        // out and reports again means the second one; keeping the first would
        // silently discard the correction.
        findings = input

        return input.postings.length === 0
          ? "Recorded: no postings. That is the whole answer — reply with one short line and stop."
          : `Recorded ${input.postings.length} posting(s). That is the whole answer — reply with one short line and stop, and do not search again.`
      },
      {
        name: "submit_findings",
        description:
          "Report the postings you found. Call this exactly once, when you have searched every board and read the shortlist — it is how the findings reach the brief, and a run that never calls it has found nothing. Name each posting by the id a search gave it.",
        schema: ScoutFindingsSchema,
      }
    ),

    submitted() {
      return findings
    },
  }
}
