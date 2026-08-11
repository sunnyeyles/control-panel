/**
 * The eval CLI: run every case against a real model and record the scores in
 * Langfuse.
 *
 * A standalone script rather than a vitest suite, and deliberately. Evals are
 * *scored*, repeated to see their variance, and compared against a previous
 * run — none of which fits an assert-or-fail runner, and all of which fits the
 * shape `apps/briefing-worker/src/dev/` already uses for "run it against the
 * real model and write the result somewhere".
 *
 * **The run is a Langfuse experiment, and that is the whole reason this file is
 * short.** Scoring, aggregation, the markdown summary, per-item traces and
 * run-over-run comparison all belong to `experiment.run`. What stays here is
 * the part that is about whiteboards: which cases to run, how many times, and
 * which model judges.
 *
 * **It exits non-zero only when it could not run.** A low score is information,
 * not a broken build; making it a failure would push whoever hit it toward
 * deleting the case. Missing keys, or an item that threw before it could be
 * graded, are different — those mean the numbers are absent rather than bad.
 *
 *     pnpm turbo run eval --filter=@workspace/agents
 *     EVAL_CASES=insert-cache,critique-only pnpm turbo run eval …
 *     EVAL_REPEATS=3 pnpm turbo run eval …
 */

import { LangfuseClient } from "@langfuse/client"
import { createModel } from "@workspace/agents-core"
import {
  createLangfuseCallback,
  initializeLangfuse,
  shutdownLangfuse,
} from "@workspace/langfuse"

import { CASES } from "./cases/index.ts"
import { createJudge, meanScore, structural } from "./evaluators.ts"
import { runTurn } from "./runner.ts"
import { WHITEBOARD_MODEL } from "../src/whiteboard.ts"
import type { EvalCase, EvalExpectation } from "./types.ts"

/**
 * Cases no longer run one at a time.
 *
 * They used to, because a rate limit part-way through a fan-out turned a
 * handful of unrelated cases into zeroes that looked like regressions. That is
 * no longer what happens: `experiment.run` settles each item on its own, so a
 * throttled case is dropped from the results with an error logged, and the
 * cases beside it still score. Four at a time is a compromise between a full
 * pass taking minutes and hammering one account; lower it if the account is
 * tight.
 */
const DEFAULT_CONCURRENCY = 4

function selectedCases(): EvalCase[] {
  const only = (process.env.EVAL_CASES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  return only.length === 0
    ? CASES
    : CASES.filter((kase) => only.includes(kase.name))
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY is not set. These evals call a real model; there is nothing to run without it."
    )
    process.exitCode = 1
    return
  }

  // Doubles as the credentials check. `initializeLangfuse` answers false when
  // the keys are absent, and unlike every other caller in this repo an eval
  // cannot carry on without them — the scores would have nowhere to go.
  if (!initializeLangfuse({ exportMode: "batched" })) {
    console.error(
      "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set. An eval records its scores in Langfuse; without them a run would produce nothing to read."
    )
    process.exitCode = 1
    return
  }

  const selected = selectedCases()
  if (selected.length === 0) {
    console.error(
      `EVAL_CASES matched nothing. Known cases: ${CASES.map((c) => c.name).join(", ")}`
    )
    process.exitCode = 1
    return
  }

  const repeats = Math.max(1, Number(process.env.EVAL_REPEATS ?? "1") || 1)
  const model = process.env.EVAL_MODEL ?? WHITEBOARD_MODEL
  const judgeModelName = process.env.EVAL_JUDGE_MODEL ?? WHITEBOARD_MODEL
  const maxConcurrency = Math.max(
    1,
    Number(process.env.EVAL_CONCURRENCY ?? DEFAULT_CONCURRENCY) ||
      DEFAULT_CONCURRENCY
  )

  console.log(
    `Running ${selected.length} case(s) × ${repeats} against ${model}, judged by ${judgeModelName}, ${maxConcurrency} at a time.\n`
  )

  // One item per case per repeat. The whole case is the input so the graders
  // can read the expectations straight off it, and so the Langfuse UI shows the
  // starting board beside the turn it produced.
  const data = selected.flatMap((kase) =>
    Array.from({ length: repeats }, (_, index) => ({
      input: kase,
      expectedOutput: kase.expect,
      metadata: { case: kase.name, intent: kase.intent, repeat: index + 1 },
    }))
  )

  const client = new LangfuseClient()
  // Spelled out rather than inferred: `data` is a positional field on the
  // config object, so nothing pins `Input` before `task` and the evaluators are
  // checked against it, and they would all see `unknown`.
  const result = await client.experiment.run<EvalCase, EvalExpectation>({
    name: "whiteboard",
    description:
      "One turn of the whiteboard agent per case, graded structurally and by a judge.",
    metadata: { model, judgeModel: judgeModelName, repeats },
    data,
    // The callback is built inside the task, which is where the experiment's
    // span is active — that is what nests the graph's model and tool calls
    // under the item rather than leaving them at the root of the project.
    //
    // `item.input` is cast because `ExperimentItem` is a union with the SDK's
    // hosted `DatasetItem`, whose `input` is untyped; the arm this run uses is
    // the one built out of `CASES` a dozen lines above. The evaluators need no
    // such cast — `EvaluatorParams.input` is the plain generic.
    task: (item) => {
      const kase = item.input as EvalCase
      const callback = createLangfuseCallback({
        tags: ["eval", "whiteboard", kase.name],
      })
      return runTurn(kase, callback ? { callbacks: [callback] } : {})
    },
    evaluators: [
      structural,
      createJudge(createModel({ model: judgeModelName })),
    ],
    runEvaluators: [meanScore],
    maxConcurrency,
  })

  console.log(await result.format({ includeItemResults: true }))
  if (result.datasetRunUrl) console.log(`\n${result.datasetRunUrl}`)

  await shutdownLangfuse()

  // `experiment.run` drops an item whose task threw, having logged it. That is
  // the right call mid-run — one broken case must not cost the other eighteen
  // their scores — but it is not something to exit 0 on.
  const missing = data.length - result.itemResults.length
  if (missing > 0) {
    console.error(
      `\n${missing} run(s) threw before they could be graded. That is a broken harness, not a low score.`
    )
    process.exitCode = 1
  }
}

await main()
