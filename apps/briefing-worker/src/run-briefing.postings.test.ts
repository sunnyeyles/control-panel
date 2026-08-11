import { postingId } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import {
  FINDINGS,
  SLOT,
  installRunBriefingFixtures,
  kept,
  recorded,
  run,
  tracked,
} from "./run-briefing.test-helpers.ts"
import type { TraceEvent } from "./trace.ts"

installRunBriefingFixtures()

/**
 * The cumulative record — the one a Posting, and the status a person set on
 * it, outlives an individual run through. The trade is the findings' trade,
 * one step later: the brief is the product, so losing the accessory record
 * costs a warning rather than the run.
 */
describe("postings", () => {
  it("records what the scout found, attributed to the run", async () => {
    const report = await run()

    expect(tracked).toEqual([
      {
        runId: SLOT.runId,
        postings: [
          {
            // The id the agents package derives, not one this file invents.
            postingId: postingId({ url: "https://example.com/jobs/1" }),
            title: "Senior Backend Engineer",
            company: "Acme",
            location: "Sydney",
            url: "https://example.com/jobs/1",
            payload: FINDINGS.postings[0],
          },
        ],
      },
    ])
    expect(report.warnings).toBeUndefined()
  })

  it("succeeds with a warning when they cannot be recorded", async () => {
    const report = await run({
      recordPostings: async () => {
        throw new Error("the postings table is gone")
      },
    })

    // The brief exists, is recorded, and the findings were kept — so the run
    // succeeded. The loss is carried as a structured warning, which `runTick`
    // passes to `finishRun`: `succeeded` with a non-empty `failure`.
    expect(report.outcome).toBe("success")
    expect(recorded).toHaveLength(1)
    expect(kept).toHaveLength(1)
    expect(report.warnings).toEqual({
      postings: { message: "the postings table is gone" },
    })
  })

  it("carries both losses when neither record could be written", async () => {
    const report = await run({
      recordFindings: async () => {
        throw new Error("the runs row is gone")
      },
      recordPostings: async () => {
        throw new Error("the postings table is gone")
      },
    })

    // Two independent writes, so one warning must not overwrite the other.
    expect(report.outcome).toBe("success")
    expect(report.warnings).toEqual({
      findings: { message: "the runs row is gone" },
      postings: { message: "the postings table is gone" },
    })
  })

  it("reports the failed write as a step that still ended", async () => {
    const events: TraceEvent[] = []

    await run({
      trace: (event) => events.push(event),
      recordPostings: async () => {
        throw new Error("the postings table is gone")
      },
    })

    expect(
      events.find(
        (event) =>
          event.type === "step" &&
          event.phase === "end" &&
          event.step === "postings"
      )
    ).toMatchObject({ detail: "not recorded — the postings table is gone" })
    expect(events.at(-1)).toMatchObject({
      type: "run",
      phase: "end",
      outcome: "success",
    })
  })
})
