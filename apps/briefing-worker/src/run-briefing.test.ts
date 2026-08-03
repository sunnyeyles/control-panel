import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import type { Artifact, ClaimedSlot, DueJob } from "@workspace/db"
import type { BriefStore, NewBrief, StoredBrief } from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentLike, AgentStreamOptions } from "./run-agent.ts"
import { runBriefing } from "./run-briefing.ts"
import type { TraceEvent } from "./trace.ts"

/**
 * The run is driven with fake agents rather than a fake model, which is what
 * the `createScout`/`createWriter` seams exist for. Every assertion here is
 * about the *structure* of a run — did a search happen, did the hand-off
 * validate, is the key derived from the occurrence — never about prose, so
 * nothing needs an API key and nothing depends on what a model happens to say.
 */

const SLOT: ClaimedSlot = {
  runId: "11111111-1111-4111-8111-111111111111",
  // 23:30 UTC: the run finishes on the 29th, but the brief is for the 28th.
  scheduledFor: new Date("2026-07-28T23:30:00.000Z"),
  nextRunAt: new Date("2026-07-29T23:30:00.000Z"),
}

const JOB = {
  id: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  name: "daily job search",
  config: {
    titles: ["senior backend engineer"],
    locations: ["Sydney"],
  },
  scheduleCron: "30 9 * * *",
  scheduleTimezone: "Australia/Sydney",
  nextRunAt: SLOT.scheduledFor,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
} as DueJob

const FINDINGS = {
  postings: [
    {
      title: "Senior Backend Engineer",
      company: "Acme",
      location: "Sydney",
      url: "https://example.com/jobs/1",
      summary: "Building things.",
      matchReason: "Matches the title and location.",
    },
  ],
}

/** A successful search result — what proves the scout actually searched. */
function searchResult(): ToolMessage {
  return new ToolMessage({
    content: "1. Senior Backend Engineer\n   https://example.com/jobs/1",
    tool_call_id: "call_1",
    name: "seek_search",
    status: "success",
  })
}

/**
 * A fake agent, satisfying `AgentLike` outright rather than by a cast — which
 * is what widening that seam to a structural type bought. Building a real
 * compiled graph would test LangGraph rather than this file.
 *
 * It yields one `updates` chunk per message, keyed by the node that would have
 * produced it, then the `values` chunk carrying the final state. That is the
 * shape LangGraph streams, so the correlation of a tool result back to the
 * arguments that asked for it is genuinely exercised here.
 */
const streamOptions: AgentStreamOptions[] = []

function fakeAgent(messages: BaseMessage[], llmCalls = 2): AgentLike {
  return {
    stream: async (_input, options) => {
      streamOptions.push(options)
      return (async function* stream() {
        for (const message of messages) {
          const node = AIMessage.isInstance(message) ? "model" : "tools"
          yield ["updates", { [node]: { messages: [message] } }]
        }

        yield ["values", { messages, llmCalls }]
      })()
    },
  }
}

function scoutReturning(text: string, tools: ToolMessage[] = [searchResult()]) {
  return () => fakeAgent([...tools, new AIMessage(text)])
}

function writerReturning(markdown: string) {
  return () => fakeAgent([new AIMessage(markdown)])
}

let briefs: BriefStore
let recordArtifact: (runId: string, objectKey: string) => Promise<Artifact>
let puts: NewBrief[]
let recorded: Array<{ runId: string; objectKey: string }>

beforeEach(() => {
  puts = []
  recorded = []
  streamOptions.length = 0
  // Restored first: spying on an already-spied method hands back the existing
  // spy, whose call log would otherwise accumulate across tests.
  vi.restoreAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})

  briefs = {
    put: async (brief: NewBrief): Promise<StoredBrief> => {
      puts.push(brief)
      const day = brief.occurrence.toISOString().slice(0, 10).replace(/-/g, "/")
      return {
        key: `prod/${brief.userId}/briefs/${day}/${brief.briefId}.md`,
        userId: brief.userId,
        partitionOn: brief.occurrence.toISOString().slice(0, 10),
        briefId: brief.briefId,
        size: Buffer.byteLength(brief.markdown),
        generatedAt: brief.generatedAt,
      }
    },
    get: async () => {
      throw new Error("not used")
    },
    delete: async () => undefined,
    list: async () => [],
  }

  recordArtifact = async (
    runId: string,
    objectKey: string
  ): Promise<Artifact> => {
    recorded.push({ runId, objectKey })
    return { id: "a", runId, objectKey, createdAt: new Date() }
  }
})

function run(overrides: Partial<Parameters<typeof runBriefing>[0]> = {}) {
  return runBriefing({
    job: JOB,
    slot: SLOT,
    briefs,
    recordArtifact,
    createScout: scoutReturning(JSON.stringify(FINDINGS)),
    createWriter: writerReturning("# Roles for you\n\nOne match."),
    ...overrides,
  })
}

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
      createScout: () =>
        fakeAgent([searchResult(), new AIMessage(JSON.stringify(FINDINGS))], 5),
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
      createScout: scoutReturning(
        JSON.stringify({ postings: [], notes: "Nothing open this week." })
      ),
      createWriter: writerReturning("No roles matched this week."),
    })

    expect(report.outcome).toBe("success")
    expect(report.postings).toBe(0)
    expect(recorded).toHaveLength(1)
  })

  describe("refuses to produce a brief when", () => {
    it("the job config cannot be read", async () => {
      const job = { ...JOB, config: { titles: [] } }

      await expect(run({ job })).rejects.toThrow(
        /config this worker cannot read/
      )
      expect(puts).toHaveLength(0)
      expect(recorded).toHaveLength(0)
    })

    it("no search actually succeeded", async () => {
      // Well-formed findings that never touched the web — the failure mode the
      // whole search-count check exists to catch.
      const failedSearch = new ToolMessage({
        content: "search failed",
        tool_call_id: "call_1",
        name: "seek_search",
        status: "error",
      })

      await expect(
        run({
          createScout: scoutReturning(JSON.stringify(FINDINGS), [failedSearch]),
        })
      ).rejects.toThrow(/no successful seek_search round trip/)
      expect(puts).toHaveLength(0)
    })

    it("the scout reported a URL no search returned", async () => {
      // Every field valid, every URL well-formed — and one of them never came
      // back from a search. The verbatim check is what turns "the model made
      // up a plausible link" into a failed run instead of a broken brief.
      const invented = {
        postings: [
          { ...FINDINGS.postings[0], url: "https://example.com/jobs/999" },
        ],
      }

      await expect(
        run({ createScout: scoutReturning(JSON.stringify(invented)) })
      ).rejects.toThrow(/no search returned/)
      expect(puts).toHaveLength(0)
    })

    it("the scout ran out of turns", async () => {
      // A budget halt ends on a ToolMessage rather than an AI message.
      await expect(
        run({ createScout: () => fakeAgent([searchResult()]) })
      ).rejects.toThrow(/scout did not end on an AI message/)
      expect(puts).toHaveLength(0)
    })

    it("the scout answered in prose instead of JSON", async () => {
      await expect(
        run({ createScout: scoutReturning("I found three great roles!") })
      ).rejects.toThrow(/not JSON/)
      expect(puts).toHaveLength(0)
    })

    it("the scout invented a URL that is not one", async () => {
      const bad = {
        postings: [{ ...FINDINGS.postings[0], url: "seek.com.au/job/123" }],
      }

      await expect(
        run({ createScout: scoutReturning(JSON.stringify(bad)) })
      ).rejects.toThrow(/does not match the findings schema/)
      expect(puts).toHaveLength(0)
    })

    it("the writer returned nothing", async () => {
      await expect(
        run({ createWriter: writerReturning("   \n  ") })
      ).rejects.toThrow(/empty brief/)
      expect(puts).toHaveLength(0)
      expect(recorded).toHaveLength(0)
    })
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
        "writer",
        "upload",
        "record",
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
          fakeAgent([
            asking,
            searchResult(),
            new AIMessage(JSON.stringify(FINDINGS)),
          ]),
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
      expect(completed).toEqual(["config", "scout", "handoff", "writer"])
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
})
