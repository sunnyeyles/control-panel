/**
 * Turning results into something a person can act on.
 *
 * **A single number per run is almost useless and a baseline diff is almost the
 * whole value.** Nobody knows whether 0.82 is good. Everybody knows what
 * `insert-cache 0.95 → 0.40` means, and that is the only question a prompt
 * change actually poses: did this help, and what did it break. So the report is
 * built around the comparison, and the absolute scores are there to explain it.
 *
 * Pure functions over plain data, so the formatting is tested rather than
 * eyeballed at the end of a run that cost money.
 */

import type { CaseResult } from "./types.ts"

/** Under this a case has genuinely changed rather than wobbled. */
export const REGRESSION_THRESHOLD = 0.05

export interface CaseSummary {
  name: string
  intent: string
  /** Mean overall across this case's repeats. */
  score: number
  /** Spread across repeats. High variance is itself a finding. */
  spread: number
  repeats: number
  llmCalls: number
  /** Graders that failed on at least one repeat, with why. */
  failures: string[]
  errors: number
}

export interface Baseline {
  /** ISO timestamp, stamped by the caller — the runner cannot read a clock. */
  recordedAt: string
  model: string
  cases: Record<string, number>
}

export interface Comparison {
  name: string
  now: number
  before: number | undefined
  delta: number | undefined
  verdict: "new" | "better" | "worse" | "same"
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function summarise(results: CaseResult[]): CaseSummary[] {
  const byCase = new Map<string, CaseResult[]>()
  for (const result of results) {
    const list = byCase.get(result.name) ?? []
    list.push(result)
    byCase.set(result.name, list)
  }

  return [...byCase.entries()].map(([name, runs]) => {
    const scores = runs.map((run) => run.overall)
    const failures = new Set<string>()
    for (const run of runs) {
      for (const score of run.scores) {
        if (!score.passed) failures.add(`${score.grader}: ${score.detail}`)
      }
    }

    return {
      name,
      intent: runs[0]?.intent ?? "",
      score: round2(mean(scores)),
      spread: round2(Math.max(...scores) - Math.min(...scores)),
      repeats: runs.length,
      llmCalls: Math.round(mean(runs.map((run) => run.llmCalls))),
      failures: [...failures],
      errors: runs.filter((run) => run.error).length,
    }
  })
}

export function compare(
  summaries: CaseSummary[],
  baseline: Baseline | undefined
): Comparison[] {
  return summaries.map((summary) => {
    const before = baseline?.cases[summary.name]
    if (before === undefined) {
      return {
        name: summary.name,
        now: summary.score,
        before: undefined,
        delta: undefined,
        verdict: "new" as const,
      }
    }

    const delta = round2(summary.score - before)
    return {
      name: summary.name,
      now: summary.score,
      before,
      delta,
      verdict:
        delta <= -REGRESSION_THRESHOLD
          ? ("worse" as const)
          : delta >= REGRESSION_THRESHOLD
            ? ("better" as const)
            : ("same" as const),
    }
  })
}

const MARK: Record<Comparison["verdict"], string> = {
  new: "new",
  better: "▲",
  worse: "▼",
  same: "·",
}

export function toMarkdown(
  summaries: CaseSummary[],
  comparisons: Comparison[],
  meta: { model: string; judgeModel: string; recordedAt: string }
): string {
  const byName = new Map(comparisons.map((entry) => [entry.name, entry]))
  const overall = round2(mean(summaries.map((summary) => summary.score)))
  const worse = comparisons.filter((entry) => entry.verdict === "worse")

  const lines: string[] = [
    "# Whiteboard evals",
    "",
    `Run ${meta.recordedAt} · agent \`${meta.model}\` · judge \`${meta.judgeModel}\``,
    "",
    `**Overall ${overall}** across ${summaries.length} case(s).`,
    "",
  ]

  if (worse.length > 0) {
    lines.push(
      `⚠️ ${worse.length} case(s) regressed: ${worse
        .map((entry) => `\`${entry.name}\` ${entry.before} → ${entry.now}`)
        .join(", ")}`,
      ""
    )
  }

  lines.push(
    "| case | score | vs baseline | spread | calls | notes |",
    "| --- | --- | --- | --- | --- | --- |"
  )

  for (const summary of summaries) {
    const entry = byName.get(summary.name)
    const against =
      entry?.before === undefined
        ? "new"
        : `${MARK[entry.verdict]} ${entry.delta! >= 0 ? "+" : ""}${entry.delta}`
    const notes =
      summary.errors > 0
        ? `**${summary.errors} run(s) crashed**`
        : summary.failures.length === 0
          ? "—"
          : summary.failures.length
    lines.push(
      `| \`${summary.name}\` | ${summary.score} | ${against} | ${summary.spread} | ${summary.llmCalls} | ${notes} |`
    )
  }

  const failing = summaries.filter(
    (summary) => summary.failures.length > 0 || summary.errors > 0
  )
  if (failing.length > 0) {
    lines.push("", "## What failed", "")
    for (const summary of failing) {
      lines.push(`### \`${summary.name}\``, "", `_${summary.intent}_`, "")
      if (summary.errors > 0) {
        lines.push(`- **${summary.errors} run(s) threw before being graded.**`)
      }
      for (const failure of summary.failures) lines.push(`- ${failure}`)
      lines.push("")
    }
  }

  return lines.join("\n")
}

export function toBaseline(
  summaries: CaseSummary[],
  meta: { model: string; recordedAt: string }
): Baseline {
  return {
    recordedAt: meta.recordedAt,
    model: meta.model,
    cases: Object.fromEntries(
      summaries.map((summary) => [summary.name, summary.score])
    ),
  }
}
