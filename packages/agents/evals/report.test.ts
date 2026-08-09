/**
 * The report is what anyone actually looks at, and a run that produced it cost
 * money — so its formatting is tested here rather than discovered to be wrong
 * at the end of one.
 *
 * The comparison logic carries the most weight. A diff that called noise a
 * regression would have people chasing prompt changes that never happened; one
 * that called a real regression noise would let a bad change land quietly.
 */

import { describe, expect, it } from "vitest"

import {
  compare,
  summarise,
  toBaseline,
  toMarkdown,
  REGRESSION_THRESHOLD,
  type Baseline,
} from "./report.ts"
import type { CaseResult } from "./types.ts"

function result(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    name: "draw-thing",
    intent: "draws a thing",
    repeat: 1,
    scores: [],
    overall: 1,
    llmCalls: 3,
    durationMs: 1000,
    ...overrides,
  }
}

const META = {
  model: "gpt-5.4",
  judgeModel: "gpt-5.4",
  recordedAt: "2026-08-10T00:00:00.000Z",
}

describe("summarise", () => {
  it("averages a case's repeats and reports their spread", () => {
    const [summary] = summarise([
      result({ overall: 1, repeat: 1 }),
      result({ overall: 0.5, repeat: 2 }),
    ])

    expect(summary?.score).toBe(0.75)
    expect(summary?.spread).toBe(0.5)
    expect(summary?.repeats).toBe(2)
  })

  it("collects the failing graders across repeats, deduped", () => {
    const failure = {
      grader: "noOverlap",
      score: 0,
      passed: false,
      detail: "1 overlapping pair(s): A/B",
    }
    const [summary] = summarise([
      result({ scores: [failure], repeat: 1 }),
      result({ scores: [failure], repeat: 2 }),
    ])

    expect(summary?.failures).toEqual(["noOverlap: 1 overlapping pair(s): A/B"])
  })

  it("counts a crash separately from a low score", () => {
    const [summary] = summarise([
      result({ overall: 0, error: "boom" }),
      result({ overall: 1, repeat: 2 }),
    ])

    expect(summary?.errors).toBe(1)
  })

  it("keeps cases apart", () => {
    const summaries = summarise([
      result({ name: "a" }),
      result({ name: "b", overall: 0.5 }),
    ])

    expect(summaries.map((entry) => entry.name)).toEqual(["a", "b"])
  })
})

describe("compare", () => {
  const baseline: Baseline = {
    recordedAt: "2026-08-01T00:00:00.000Z",
    model: "gpt-5.4",
    cases: { steady: 0.9, dropped: 0.9, climbed: 0.5 },
  }

  const summaries = summarise([
    result({ name: "steady", overall: 0.92 }),
    result({ name: "dropped", overall: 0.4 }),
    result({ name: "climbed", overall: 0.85 }),
    result({ name: "fresh", overall: 0.7 }),
  ])

  it("calls a small wobble the same, not a change", () => {
    const [steady] = compare(summaries, baseline)
    expect(steady?.verdict).toBe("same")
  })

  it("names a real drop as worse, with the delta", () => {
    const dropped = compare(summaries, baseline)[1]
    expect(dropped?.verdict).toBe("worse")
    expect(dropped?.delta).toBe(-0.5)
  })

  it("names a real gain as better", () => {
    expect(compare(summaries, baseline)[2]?.verdict).toBe("better")
  })

  it("marks a case the baseline has never seen as new", () => {
    const fresh = compare(summaries, baseline)[3]
    expect(fresh?.verdict).toBe("new")
    expect(fresh?.delta).toBeUndefined()
  })

  it("treats a change exactly at the threshold as a change", () => {
    const atEdge = summarise([
      result({ name: "steady", overall: 0.9 - REGRESSION_THRESHOLD }),
    ])
    expect(compare(atEdge, baseline)[0]?.verdict).toBe("worse")
  })

  it("calls everything new with no baseline at all", () => {
    expect(
      compare(summaries, undefined).every((entry) => entry.verdict === "new")
    ).toBe(true)
  })
})

describe("toMarkdown", () => {
  it("leads with the regressions, which is the reason anyone reads it", () => {
    const summaries = summarise([result({ name: "dropped", overall: 0.4 })])
    const baseline: Baseline = {
      recordedAt: "2026-08-01T00:00:00.000Z",
      model: "gpt-5.4",
      cases: { dropped: 0.95 },
    }

    const markdown = toMarkdown(summaries, compare(summaries, baseline), META)

    expect(markdown).toContain("1 case(s) regressed")
    expect(markdown).toContain("`dropped` 0.95 → 0.4")
  })

  it("says nothing about regressions when there are none", () => {
    const summaries = summarise([result({ overall: 1 })])
    const markdown = toMarkdown(summaries, compare(summaries, undefined), META)

    expect(markdown).not.toContain("regressed")
  })

  it("puts every case in the table with its score", () => {
    const summaries = summarise([
      result({ name: "a", overall: 1 }),
      result({ name: "b", overall: 0.5 }),
    ])
    const markdown = toMarkdown(summaries, compare(summaries, undefined), META)

    expect(markdown).toContain("| `a` | 1 |")
    expect(markdown).toContain("| `b` | 0.5 |")
  })

  it("spells out what failed, under the case that failed it", () => {
    const summaries = summarise([
      result({
        name: "messy",
        intent: "tidies a board",
        overall: 0.5,
        scores: [
          {
            grader: "noOverlap",
            score: 0,
            passed: false,
            detail: "2 overlapping pair(s): A/B, C/D",
          },
        ],
      }),
    ])
    const markdown = toMarkdown(summaries, compare(summaries, undefined), META)

    expect(markdown).toContain("## What failed")
    expect(markdown).toContain("### `messy`")
    expect(markdown).toContain("_tidies a board_")
    expect(markdown).toContain("2 overlapping pair(s): A/B, C/D")
  })

  it("calls a crash a crash rather than a score", () => {
    const summaries = summarise([result({ overall: 0, error: "boom" })])
    const markdown = toMarkdown(summaries, compare(summaries, undefined), META)

    expect(markdown).toContain("run(s) crashed")
    expect(markdown).toContain("threw before being graded")
  })

  it("records which models produced the numbers", () => {
    const markdown = toMarkdown([], [], META)
    expect(markdown).toContain("agent `gpt-5.4`")
    expect(markdown).toContain("judge `gpt-5.4`")
  })
})

describe("toBaseline", () => {
  it("keeps one score per case, and what produced it", () => {
    const summaries = summarise([
      result({ name: "a", overall: 0.9 }),
      result({ name: "b", overall: 0.4 }),
    ])

    expect(
      toBaseline(summaries, { model: "gpt-5.4", recordedAt: META.recordedAt })
    ).toEqual({
      recordedAt: META.recordedAt,
      model: "gpt-5.4",
      cases: { a: 0.9, b: 0.4 },
    })
  })

  it("round-trips through compare as unchanged", () => {
    const summaries = summarise([result({ name: "a", overall: 0.9 })])
    const baseline = toBaseline(summaries, {
      model: "gpt-5.4",
      recordedAt: META.recordedAt,
    })

    expect(compare(summaries, baseline)[0]?.verdict).toBe("same")
  })
})
