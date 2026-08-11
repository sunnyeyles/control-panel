import { describe, expect, it } from "vitest"

import {
  FINDINGS,
  SLOT,
  installRunBriefingFixtures,
  kept,
  recorded,
  run,
} from "./run-briefing.test-helpers.ts"
import type { TraceEvent } from "./trace.ts"

installRunBriefingFixtures()

/**
 * The findings are the record the brief was written from, and they outlive
 * the run only if something keeps them. What matters here is the trade: the
 * brief is the product, so losing the record must cost a warning rather than
 * the run.
 */
describe("findings", () => {
  it("keeps the validated findings against the run", async () => {
    const report = await run()

    expect(kept).toEqual([{ runId: SLOT.runId, findings: FINDINGS }])
    expect(report.warnings).toBeUndefined()
  })

  it("succeeds with a warning when they cannot be kept", async () => {
    const report = await run({
      recordFindings: async () => {
        throw new Error("the runs row is gone")
      },
    })

    // The brief exists and is recorded, so the run succeeded. The loss is
    // carried as a structured warning — `runTick` passes exactly this to
    // `finishRun`, whose row stays `succeeded` with a non-empty `failure`.
    expect(report.outcome).toBe("success")
    expect(recorded).toHaveLength(1)
    expect(report.warnings).toEqual({
      findings: { message: "the runs row is gone" },
    })
  })

  it("reports the failed write as a step that still ended", async () => {
    const events: TraceEvent[] = []

    await run({
      trace: (event) => events.push(event),
      recordFindings: async () => {
        throw new Error("the runs row is gone")
      },
    })

    // A step that swallowed its error and then emitted no `end` would leave
    // the transcript claiming the run hung on it.
    expect(
      events.find(
        (event) =>
          event.type === "step" &&
          event.phase === "end" &&
          event.step === "findings"
      )
    ).toMatchObject({ detail: "not recorded — the runs row is gone" })
    expect(events.at(-1)).toMatchObject({
      type: "run",
      phase: "end",
      outcome: "success",
    })
  })
})
