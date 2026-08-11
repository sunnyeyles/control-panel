import { AIMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"

import {
  JOB,
  SCOUT_FINDINGS,
  SLOT,
  fakeAgent,
  fakeSession,
  installRunBriefingFixtures,
  puts,
  recorded,
  run,
  scoutReturning,
  streamOptions,
  writerReturning,
} from "./run-briefing.test-helpers.ts"

installRunBriefingFixtures()

describe("runBriefing", () => {
  it("writes the brief, then records the key", async () => {
    const report = await run()

    expect(report.outcome).toBe("success")
    expect(report.postings).toBe(1)
    expect(report.searches).toBe(1)

    // The row is the claim that a brief exists, so it is written only once the
    // object is. A row pointing at nothing is worse than no row.
    expect(puts).toHaveLength(1)
    expect(recorded).toEqual([
      { runId: SLOT.runId, objectKey: report.objectKey },
    ])
  })

  it("keys the brief by run id, partitioned on the occurrence", async () => {
    const report = await run()

    // 23:30 UTC on the 28th: the run executes now, but the brief belongs to the
    // slot's day, not to whenever this test happens to run.
    expect(puts[0]?.briefId).toBe(SLOT.runId)
    expect(puts[0]?.occurrence).toBe(SLOT.scheduledFor)
    expect(report.objectKey).toBe(
      `prod/${JOB.userId}/briefs/2026/07/28/${SLOT.runId}.md`
    )
  })

  it("sums model calls across both agents", async () => {
    const report = await run({
      createScout: () => fakeSession({ findings: SCOUT_FINDINGS, llmCalls: 5 }),
      createWriter: () => fakeAgent([new AIMessage("# Brief")], 1),
    })

    expect(report.llmCalls).toBe(6)
  })

  it("names and tags both agent streams for Langfuse", async () => {
    await run()

    expect(streamOptions).toEqual([
      expect.objectContaining({
        metadata: {
          agent: "scout",
          jobId: JOB.id,
          runId: SLOT.runId,
        },
        runName: "find-postings",
        tags: ["briefing", "scout"],
      }),
      expect.objectContaining({
        metadata: {
          agent: "writer",
          jobId: JOB.id,
          runId: SLOT.runId,
        },
        runName: "write-brief",
        tags: ["briefing", "writer"],
      }),
    ])
  })

  it("treats an honest empty result as a success", async () => {
    const report = await run({
      createScout: scoutReturning({
        postings: [],
        notes: "Nothing open this week.",
      }),
      createWriter: writerReturning("No roles matched this week."),
    })

    expect(report.outcome).toBe("success")
    expect(report.postings).toBe(0)
    expect(recorded).toHaveLength(1)
  })

  it("emits exactly one report line on both paths", async () => {
    const log = vi.mocked(console.log)

    await run()
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).outcome).toBe("success")

    log.mockClear()
    await expect(run({ createWriter: writerReturning("") })).rejects.toThrow()
    expect(log).toHaveBeenCalledTimes(1)

    const failure = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(failure.outcome).toBe("failure")
    // A failure report still carries how far the run got.
    expect(failure.searches).toBe(1)
    expect(failure.runId).toBe(SLOT.runId)
  })
})
