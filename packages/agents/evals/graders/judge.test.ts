/**
 * The judge, driven by a scripted model — so the one grader that costs money in
 * production costs nothing to test.
 *
 * What is worth asserting here is not whether the judge has good taste, which
 * no test can establish. It is the plumbing around it: that a malformed verdict
 * is reported as the harness failing rather than as the agent scoring zero,
 * that the 1–5 rubric lands on the same 0–1 scale as everything else, and that
 * the board reaches it as rendered text rather than as raw objects.
 */

import { AIMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import { board, shape } from "../cases/support.ts"
import type { EvalCase, TurnResult } from "../types.ts"
import { judge, JUDGE_SYSTEM_PROMPT } from "./judge.ts"

/** Replies with a fixed string and records what it was asked. */
function scriptedModel(reply: string) {
  const seen: BaseMessage[][] = []
  return {
    seen,
    bindTools() {
      return {
        async invoke(messages: BaseMessage[]): Promise<AIMessage> {
          seen.push(messages)
          return new AIMessage({ content: reply })
        },
      }
    },
  }
}

const KASE: EvalCase = {
  name: "test",
  intent: "test",
  board: board({ shapes: [shape("s1", "Client", 0, 0)] }),
  prompt: "Draw a client talking to an API",
  expect: { judge: "Whether it drew the API." },
}

const RESULT: TurnResult = {
  ops: [],
  toolCalls: [],
  toolReplies: [],
  reply: "Drawn — a client and the API it calls.",
  llmCalls: 2,
  finalShapes: [shape("s1", "Client", 0, 0), shape("s2", "API", 400, 0)],
  finalConnections: [{ id: "s3", fromId: "s1", toId: "s2" }],
  durationMs: 10,
}

const GOOD_VERDICT = JSON.stringify({
  faithfulness: 5,
  readability: 4,
  reply: 4,
  justification: "Both boxes present and the arrow points the right way.",
})

describe("judge", () => {
  it("returns nothing when the case did not ask to be judged", async () => {
    const unjudged: EvalCase = { ...KASE, expect: {} }

    expect(
      await judge({ kase: unjudged, result: RESULT }, scriptedModel("{}"))
    ).toEqual([])
  })

  it("turns a 1-5 rubric into three scores on the 0-1 scale", async () => {
    const scores = await judge(
      { kase: KASE, result: RESULT },
      scriptedModel(GOOD_VERDICT)
    )

    expect(scores.map((score) => score.grader)).toEqual([
      "judge:faithfulness",
      "judge:readability",
      "judge:reply",
    ])
    // 5/5 is 1, 4/5 is 0.75 — the bottom of the rubric is 1, not 0.
    expect(scores[0]?.score).toBe(1)
    expect(scores[1]?.score).toBe(0.75)
  })

  it("fails a rating below 4, because a near miss is still the wrong diagram", async () => {
    const scores = await judge(
      { kase: KASE, result: RESULT },
      scriptedModel(
        JSON.stringify({
          faithfulness: 2,
          readability: 5,
          reply: 5,
          justification: "Drew a completely different system.",
        })
      )
    )

    expect(scores[0]?.passed).toBe(false)
    expect(scores[1]?.passed).toBe(true)
  })

  it("carries the justification onto every score, so the report says why", async () => {
    const scores = await judge(
      { kase: KASE, result: RESULT },
      scriptedModel(GOOD_VERDICT)
    )

    for (const score of scores) {
      expect(score.detail).toContain("arrow points the right way")
    }
  })

  it("strips a code fence, which models add despite being asked not to", async () => {
    const scores = await judge(
      { kase: KASE, result: RESULT },
      scriptedModel(`\`\`\`json\n${GOOD_VERDICT}\n\`\`\``)
    )

    expect(scores[0]?.score).toBe(1)
  })

  /**
   * The important one. A judge that fell over must not look like an agent that
   * drew badly — that would fold a harness outage into a baseline as a
   * regression, and someone would go looking for a prompt change that never
   * happened.
   */
  it("reports its own failure as its own, not as a bad diagram", async () => {
    const scores = await judge(
      { kase: KASE, result: RESULT },
      scriptedModel("I think it was pretty good, honestly.")
    )

    expect(scores).toHaveLength(1)
    expect(scores[0]?.grader).toBe("judge")
    expect(scores[0]?.detail).toContain("the judge did not answer")
    expect(scores[0]?.unscored).toBe(true)
  })

  it("rejects a rating outside the rubric rather than scaling it", async () => {
    const scores = await judge(
      { kase: KASE, result: RESULT },
      scriptedModel(
        JSON.stringify({
          faithfulness: 11,
          readability: 4,
          reply: 4,
          justification: "…",
        })
      )
    )

    expect(scores[0]?.grader).toBe("judge")
    expect(scores[0]?.passed).toBe(false)
  })

  it("shows the judge the board as rendered text, both before and after", async () => {
    const model = scriptedModel(GOOD_VERDICT)
    await judge({ kase: KASE, result: RESULT }, model)

    const prompt =
      model.seen[0]?.map((message) => message.text).join("\n") ?? ""

    expect(prompt).toContain(JUDGE_SYSTEM_PROMPT)
    expect(prompt).toContain("The board before the turn:")
    expect(prompt).toContain("The board after the turn:")
    // One line per shape, from the same renderer the agent itself reads.
    expect(prompt).toContain('s2 rectangle "API" at (400, 0)')
    expect(prompt).toContain("s3: s1 -> s2")
    expect(prompt).toContain("Whether it drew the API.")
  })

  it("says so plainly when the assistant said nothing", async () => {
    const model = scriptedModel(GOOD_VERDICT)
    await judge({ kase: KASE, result: { ...RESULT, reply: "" } }, model)

    const prompt =
      model.seen[0]?.map((message) => message.text).join("\n") ?? ""
    expect(prompt).toContain("(nothing)")
  })
})

describe("the judge prompt", () => {
  it("asks for the three things the structural graders cannot see", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/faithfulness/)
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/readability/)
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/reply/)
  })

  it("tells it to use the whole range, or the scores say nothing", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/use the whole range/i)
  })

  it("fences the material it is shown, since the board is user text", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/quoted material/i)
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/ignore it/i)
  })

  it("warns it that it is reading a description, not looking at a picture", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/not being shown an image/i)
  })

  it("asks for bare JSON", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/no code fence/i)
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/no preamble/i)
  })
})
