/**
 * The eval CLI: run every case against a real model, score it, write a report.
 *
 * A standalone script rather than a vitest suite, and deliberately. Evals are
 * *scored*, repeated to see their variance, and compared against a previous
 * run — none of which fits an assert-or-fail runner, and all of which fits the
 * shape `apps/briefing-worker/src/dev/` already uses for "run it against the
 * real model and write the result to disk".
 *
 * **It exits non-zero only when it could not run.** A low score is information,
 * not a broken build; making it a failure would push whoever hit it toward
 * deleting the case. A crash, a missing key or an unparseable baseline are
 * different — those mean the numbers are absent rather than bad.
 *
 *     pnpm turbo run eval --filter=@workspace/agents
 *     EVAL_CASES=insert-cache,critique-only pnpm turbo run eval …
 *     EVAL_REPEATS=3 pnpm turbo run eval …
 *     EVAL_WRITE_BASELINE=1 pnpm turbo run eval …
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createModel } from "@workspace/agents-core"
import { createLangfuseCallback } from "@workspace/langfuse"

import { CASES } from "./cases/index.ts"
import { judge } from "./graders/judge.ts"
import { gradeStructurally } from "./graders/structural.ts"
import {
  compare,
  summarise,
  toBaseline,
  toMarkdown,
  type Baseline,
} from "./report.ts"
import { runTurn } from "./runner.ts"
import { WHITEBOARD_MODEL } from "../src/whiteboard.ts"
import type { CaseResult, EvalCase, Score } from "./types.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(HERE, "baseline.json")
const RESULTS_DIR = join(HERE, "results")

/**
 * Cases run one at a time.
 *
 * Concurrency would finish sooner and is not worth it: these are long
 * tool-calling runs against one account, and a rate limit part-way through a
 * fan-out turns a handful of unrelated cases into zeroes that look like
 * regressions. A full pass is minutes, not hours.
 */
async function runCase(
  kase: EvalCase,
  repeat: number,
  judgeModel: ReturnType<typeof createModel>
): Promise<CaseResult> {
  const base = { name: kase.name, intent: kase.intent, repeat }

  try {
    const callback = createLangfuseCallback({
      tags: ["eval", "whiteboard", kase.name],
      traceMetadata: {
        feature: "whiteboard-eval",
        case: kase.name,
        repeat: String(repeat),
      },
    })

    const result = await runTurn(kase, {
      ...(callback ? { callbacks: [callback] } : {}),
    })

    const scores: Score[] = [
      ...gradeStructurally(kase, result),
      ...(await judge({ kase, result }, judgeModel)),
    ]

    // An unscored grader is the harness failing, not the agent, so it is left
    // out of the mean rather than averaged in as a zero.
    const scored = scores.filter((score) => !score.unscored)
    const overall =
      scored.length === 0
        ? 1
        : scored.reduce((total, score) => total + score.score, 0) /
          scored.length

    return {
      ...base,
      scores,
      overall: Math.round(overall * 100) / 100,
      llmCalls: result.llmCalls,
      durationMs: result.durationMs,
    }
  } catch (error) {
    // A thrown run is missing data, not a zero. `summarise` counts it
    // separately and the report says so rather than folding it into a mean.
    return {
      ...base,
      scores: [],
      overall: 0,
      llmCalls: 0,
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function readBaseline(): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Baseline
  } catch (error) {
    // No baseline is the ordinary first run, and is not worth a warning that
    // would then be printed on every fresh checkout. A baseline that exists and
    // will not parse is the other case the docblock promises to exit on.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
    throw error
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY is not set. These evals call a real model; there is nothing to run without it."
    )
    process.exitCode = 1
    return
  }

  const only = (process.env.EVAL_CASES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  const selected =
    only.length === 0 ? CASES : CASES.filter((kase) => only.includes(kase.name))

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
  const judgeModel = createModel({ model: judgeModelName })

  console.log(
    `Running ${selected.length} case(s) × ${repeats} against ${model}, judged by ${judgeModelName}.\n`
  )

  const results: CaseResult[] = []
  for (const kase of selected) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const result = await runCase(kase, repeat, judgeModel)
      results.push(result)

      const failed = result.scores.filter((score) => !score.passed)
      const tag = result.error
        ? "CRASH"
        : failed.length === 0
          ? "ok   "
          : "fail "
      console.log(
        `  ${tag} ${kase.name}${repeats > 1 ? ` #${repeat}` : ""}  ${result.overall.toFixed(2)}  ${result.llmCalls} call(s)  ${(result.durationMs / 1000).toFixed(1)}s`
      )
      if (result.error) console.log(`        ${result.error}`)
      for (const score of failed) {
        console.log(`        ${score.grader}: ${score.detail}`)
      }
    }
  }

  // Stamped here rather than inside the pure report functions, which take the
  // timestamp as an argument so they stay testable.
  const recordedAt = new Date().toISOString()
  const stamp = recordedAt.replace(/[:.]/g, "-")

  // The raw results go to disk before anything reads them. Summarising,
  // comparing against a baseline or rendering markdown can all throw, and a run
  // that already cost minutes of real model calls should not be lost to one.
  await mkdir(RESULTS_DIR, { recursive: true })
  await writeFile(
    join(RESULTS_DIR, `${stamp}.json`),
    JSON.stringify({ recordedAt, model, judgeModelName, results }, null, 2)
  )

  const summaries = summarise(results)
  const comparisons = compare(summaries, await readBaseline())
  const markdown = toMarkdown(summaries, comparisons, {
    model,
    judgeModel: judgeModelName,
    recordedAt,
  })

  await writeFile(join(RESULTS_DIR, `${stamp}.md`), markdown)

  console.log(`\n${markdown}`)
  console.log(`\nWritten to evals/results/${stamp}.{json,md}`)

  if (process.env.EVAL_WRITE_BASELINE) {
    await writeFile(
      BASELINE_PATH,
      `${JSON.stringify(toBaseline(summaries, { model, recordedAt }), null, 2)}\n`
    )
    console.log(
      "Baseline updated. Commit it if these numbers are the new truth."
    )
  }

  const crashed = results.filter((result) => result.error).length
  if (crashed > 0) {
    console.error(
      `\n${crashed} run(s) threw. That is a broken harness, not a low score.`
    )
    process.exitCode = 1
  }
}

await main()
