/**
 * The seam between this repo's graders and Langfuse's experiment runner.
 *
 * Everything Langfuse knows about a whiteboard turn passes through this file.
 * `graders/structural.ts` and `graders/judge.ts` keep their own
 * `(EvalCase, TurnResult) => Score[]` shape and never import the SDK, which is
 * what lets them stay pure, stay tested in the ordinary `pnpm test`, and stay
 * usable if the platform underneath ever changes. All this does is rename the
 * fields.
 *
 * **A grader that throws is absent data, not a zero.** `experiment.run` settles
 * its evaluators individually: a rejection is logged and that grader's scores
 * are left out of the item, while every other grader still records. That is the
 * behaviour the judge needs — a model that fails to answer must not look like an
 * agent that drew the wrong thing — so the judge simply throws and this file
 * holds no bookkeeping for it.
 */

import type { Evaluator, RunEvaluator } from "@langfuse/client"
import type { ChatModelLike } from "@workspace/agents-core"

import { judge } from "./graders/judge.ts"
import { gradeStructurally } from "./graders/structural.ts"
import type { EvalCase, Score, TurnResult } from "./types.ts"

/** The mean of every grader on the run. What a regression gate would read. */
export const OVERALL = "overall"

function toEvaluation(score: Score) {
  return {
    name: score.grader,
    value: score.score,
    comment: score.detail,
    metadata: { passed: score.passed },
  }
}

export const structural: Evaluator<EvalCase> = async ({ input, output }) =>
  gradeStructurally(input, output as TurnResult).map(toEvaluation)

/**
 * The judge, bound to a model.
 *
 * A factory rather than a constant because {@link Evaluator} has nowhere to put
 * one, and building the model at module scope would read `OPENAI_API_KEY` on
 * import — the same reason every agent here is a `createX()` and not an
 * instance.
 */
export function createJudge(model: ChatModelLike): Evaluator<EvalCase> {
  return async ({ input, output }) =>
    (await judge({ kase: input, result: output as TurnResult }, model)).map(
      toEvaluation
    )
}

/**
 * One number for the whole run.
 *
 * Every grader is already on 0–1, so this is a plain mean rather than a
 * weighting nobody would remember the reasoning for. It exists because a run
 * needs a single metric to compare against the last one — in the Langfuse UI,
 * or through `RegressionError` if this is ever wired to a gate.
 */
export const meanScore: RunEvaluator<EvalCase> = async ({ itemResults }) => {
  const values = itemResults
    .flatMap((item) => item.evaluations)
    .map((evaluation) => evaluation.value)
    .filter((value): value is number => typeof value === "number")

  if (values.length === 0) return []

  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    name: OVERALL,
    value: Math.round((total / values.length) * 100) / 100,
    comment: `mean of ${values.length} grader score(s) across ${itemResults.length} run(s)`,
  }
}
