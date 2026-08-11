import { AIMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"

import {
  JOB,
  SCOUT_FINDINGS,
  SLOT,
  fakeSession,
  installRunBriefingFixtures,
  run,
  searchResult,
  writerReturning,
} from "./run-briefing.test-helpers.ts"
import type { TraceEvent } from "./trace.ts"
import { runBriefing } from "./run-briefing.ts"

installRunBriefingFixtures()

/**
 * The trace is the transcript, and these assert on its *shape* — that the
 * steps happen in the stated order, that a tool result is reunited with the
 * arguments that asked for it, and that a sink can neither fail a run nor be
 * skipped by one. Never on what a model said.
 */
describe("trace", () => {
  function tracedRun(
    overrides: Partial<Parameters<typeof runBriefing>[0]> = {}
  ) {
    const events: TraceEvent[] = []
    const result = run({ trace: (event) => events.push(event), ...overrides })
    return { events, result }
  }

  it("reports each step, in the order the pipeline runs them", async () => {
    const { events, result } = tracedRun()
    await result

    const completed = events
      .filter((event) => event.type === "step" && event.phase === "end")
      .map((event) => (event.type === "step" ? event.step : ""))

    expect(completed).toEqual([
      "config",
      "scout",
      "handoff",
      // After the hand-off so an excluded posting is not also reported as
      // unresolvable, and before the writer so the brief never mentions one.
      "filter",
      "writer",
      "upload",
      "record",
      "findings",
      "postings",
    ])
  })

  it("opens with the run and closes with its outcome", async () => {
    const { events, result } = tracedRun()
    await result

    expect(events.at(0)).toMatchObject({
      type: "run",
      phase: "start",
      jobId: JOB.id,
      jobName: JOB.name,
      runId: SLOT.runId,
    })
    expect(events.at(-1)).toMatchObject({
      type: "run",
      phase: "end",
      outcome: "success",
    })
  })

  it("pairs a tool result with the arguments that asked for it", async () => {
    const asking = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_1",
          name: "seek_search",
          args: { query: "senior backend engineer Sydney" },
        },
      ],
    })

    const { events, result } = tracedRun({
      createScout: () =>
        fakeSession({
          findings: SCOUT_FINDINGS,
          messages: [asking, searchResult()],
        }),
    })
    await result

    // The call and the result arrive one superstep apart, so a trace that did
    // not correlate them would show "seek_search returned five results" with
    // no way to know what was searched for.
    expect(events.filter((event) => event.type === "tool")).toEqual([
      expect.objectContaining({
        type: "tool",
        agent: "scout",
        name: "seek_search",
        args: { query: "senior backend engineer Sydney" },
        ok: true,
      }),
    ])
  })

  it("carries the error on a failed run's closing event", async () => {
    const { events, result } = tracedRun({
      createWriter: writerReturning("   "),
    })
    await expect(result).rejects.toThrow(/empty brief/)

    expect(events.at(-1)).toMatchObject({
      type: "run",
      phase: "end",
      outcome: "failure",
      error: expect.stringMatching(/empty brief/) as unknown as string,
    })

    // The steps that did run still reported, so a failure trace shows how far
    // it got rather than only where it stopped.
    const completed = events
      .filter((event) => event.type === "step" && event.phase === "end")
      .map((event) => (event.type === "step" ? event.step : ""))
    expect(completed).toEqual([
      "config",
      "scout",
      "handoff",
      "filter",
      "writer",
    ])
  })

  it("survives a sink that throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    // A debugging aid must not fail a run that costs money and cannot be
    // retried. The complaint is made once, not once per event.
    const report = await run({
      trace: () => {
        throw new Error("the renderer broke")
      },
    })

    expect(report.outcome).toBe("success")
    expect(error).toHaveBeenCalledTimes(1)
  })
})
