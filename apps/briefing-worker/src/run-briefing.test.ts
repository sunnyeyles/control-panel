import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { postingId, type Findings } from "@workspace/agents"
import type { Artifact, ClaimedSlot, DueJob, NewPosting } from "@workspace/db"
import type { BriefStore, NewBrief, StoredBrief } from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentLike, AgentStreamOptions } from "./run-agent.ts"
import { runBriefing } from "./run-briefing.ts"
import { SEARCH_TOOL_NAMES } from "./search-results.ts"
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

/**
 * Every board at zero — the breakdown a run carries before anything searched.
 *
 * Derived from the tool list rather than written out, because the number of
 * boards is not what these tests are about: pinning it here would mean a test
 * failing the next time one is added, which is exactly the noise that teaches
 * people to update an expectation without reading it.
 */
function noSearches(): Record<string, number> {
  return Object.fromEntries(SEARCH_TOOL_NAMES.map((name) => [name, 0]))
}

/** A successful search result — what proves the scout actually searched. */
function searchResult(name = "seek_search", callId = "call_1"): ToolMessage {
  return new ToolMessage({
    content: "1. Senior Backend Engineer\n   https://example.com/jobs/1",
    tool_call_id: callId,
    name,
    status: "success",
  })
}

/** A search that was called and did not answer. */
function failedSearch(name = "seek_search", callId = "call_1"): ToolMessage {
  return new ToolMessage({
    content: "search failed",
    tool_call_id: callId,
    name,
    status: "error",
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
let recordFindings: (runId: string, findings: Findings) => Promise<void>
let recordPostings: (runId: string, postings: NewPosting[]) => Promise<void>
let puts: NewBrief[]
let recorded: Array<{ runId: string; objectKey: string }>
let kept: Array<{ runId: string; findings: Findings }>
let tracked: Array<{ runId: string; postings: NewPosting[] }>

beforeEach(() => {
  puts = []
  recorded = []
  kept = []
  tracked = []
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

  recordFindings = async (runId: string, findings: Findings): Promise<void> => {
    kept.push({ runId, findings })
  }

  recordPostings = async (
    runId: string,
    postings: NewPosting[]
  ): Promise<void> => {
    tracked.push({ runId, postings })
  }
})

function run(overrides: Partial<Parameters<typeof runBriefing>[0]> = {}) {
  return runBriefing({
    job: JOB,
    slot: SLOT,
    briefs,
    recordArtifact,
    recordFindings,
    recordPostings,
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

  describe("when a search did not return one of the reported URLs", () => {
    /** One search result carrying exactly these URLs, one per stanza. */
    function returning(...urls: string[]): ToolMessage {
      return new ToolMessage({
        content: urls
          .map((url, index) => `${index + 1}. A role — A company\n   ${url}`)
          .join("\n\n"),
        tool_call_id: "call_1",
        name: "linkedin_search",
        status: "success",
      })
    }

    const REAL = FINDINGS.postings[0]!
    const INVENTED = { ...REAL, url: "https://example.com/jobs/999" }

    /** A run reporting one posting a search returned and one it did not. */
    function runWithOneInvented() {
      return run({
        createScout: scoutReturning(
          JSON.stringify({ postings: [REAL, INVENTED] }),
          [returning(REAL.url)]
        ),
      })
    }

    it("still writes the brief from the postings that survived", async () => {
      const report = await runWithOneInvented()

      // The whole point of the change: one bad URL among several is a
      // transcription slip, and throwing the run away over it threw away the
      // other postings, the brief, and the cumulative record with them.
      expect(report.outcome).toBe("success")
      expect(report.postings).toBe(1)
      expect(puts).toHaveLength(1)
      expect(kept[0]?.findings.postings).toEqual([REAL])
      expect(tracked[0]?.postings).toHaveLength(1)
    })

    it("says what it left out, since nothing else ever will", async () => {
      const report = await runWithOneInvented()

      // The brief does not mention what is missing from it and the run
      // succeeded, so without this the drop is invisible in production.
      expect(report.warnings).toEqual({
        postingUrls: {
          message:
            "1 posting left out of the brief: no search returned the URL the scout gave.",
          urls: [INVENTED.url],
        },
      })
    })

    it("reports the drop as a hand-off step detail", async () => {
      const events: TraceEvent[] = []
      await run({
        trace: (event) => events.push(event),
        createScout: scoutReturning(
          JSON.stringify({ postings: [REAL, INVENTED] }),
          [returning(REAL.url)]
        ),
      })

      expect(
        events.find(
          (event) =>
            event.type === "step" &&
            event.phase === "end" &&
            event.step === "handoff"
        )
      ).toMatchObject({
        detail: "1 posting dropped — no search returned the URL",
      })
    })

    it("stays quiet about a hand-off that dropped nothing", async () => {
      const events: TraceEvent[] = []
      await run({ trace: (event) => events.push(event) })

      // The `handoff` event already carries the findings; a detail restating
      // their count would be the same fact twice.
      expect(
        events.find(
          (event) =>
            event.type === "step" &&
            event.phase === "end" &&
            event.step === "handoff"
        )
      ).not.toHaveProperty("detail")
    })

    it("keeps a posting whose per-search decoration the scout mistyped", async () => {
      // The production failure this was written for: a real LinkedIn posting
      // reported with `position=59` where the search returned `position=58`.
      // `posting-urls.test.ts` covers the rule; this covers the run keeping
      // going, and linking to what LinkedIn issued rather than what was typed.
      //
      // A `linkedin.com` host, not the `example.com` the other fixtures use,
      // and that is the rule rather than a detail: `job-boards.ts` scopes
      // `position` to the board known to stamp it, so on any other host it is
      // a parameter that might carry identity and is kept.
      const found = "https://au.linkedin.com/jobs/view/engineer-at-acme-443814"
      const issued = `${found}?position=58&trackingId=vwiYgy%3D%3D`
      const mistyped = { ...REAL, url: `${found}?position=59` }

      const report = await run({
        createScout: scoutReturning(JSON.stringify({ postings: [mistyped] }), [
          returning(issued),
        ]),
      })

      expect(report.outcome).toBe("success")
      expect(report.warnings).toBeUndefined()
      expect(kept[0]?.findings.postings[0]?.url).toBe(issued)
    })
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
      await expect(
        run({
          createScout: scoutReturning(JSON.stringify(FINDINGS), [
            failedSearch(),
          ]),
        })
      ).rejects.toThrow(/no successful search .* on any of seek_search/)
      expect(puts).toHaveLength(0)
    })

    it("no posting the scout reported came from a search", async () => {
      // Every field valid, every URL well-formed — and not one of them came
      // back from a search. A single unaccounted-for URL is a transcription
      // slip and costs that posting alone (see below); *all* of them is a
      // scout that has stopped copying, and a brief built from the empty
      // remainder would cite nothing at all.
      const invented = {
        postings: [
          { ...FINDINGS.postings[0], url: "https://example.com/jobs/999" },
        ],
      }

      await expect(
        run({ createScout: scoutReturning(JSON.stringify(invented)) })
      ).rejects.toThrow(/no search returned any of their URLs/)
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
   * The wiring only. That a search from a *second* board counts is a property
   * of the rule rather than of this file, and it is proved in
   * `search-results.test.ts`, where the tool names can be passed in — only one
   * board exists to run through `runBriefing` today.
   */
  describe("the search count reaching the run report", () => {
    it("excludes a tool that is not a search tool", async () => {
      // A clock answering successfully is not evidence that anyone searched,
      // so widening the gate to a set must not widen it to "any tool the
      // scout happens to carry".
      const report = await run({
        createScout: scoutReturning(JSON.stringify(FINDINGS), [
          searchResult(),
          searchResult("get_current_time", "call_2"),
        ]),
      })

      expect(report.searches).toBe(1)
      expect(report.searchesBySource).toEqual({
        ...noSearches(),
        seek_search: 1,
      })
    })

    it("survives a search that failed alongside one that worked", async () => {
      // Narrower coverage, not a failed run. A board that went quiet belongs
      // in the findings' notes; it is not grounds for throwing away a brief
      // built from postings that were genuinely looked up.
      const report = await run({
        createScout: scoutReturning(JSON.stringify(FINDINGS), [
          failedSearch(),
          searchResult("seek_search", "call_2"),
        ]),
      })

      expect(report.outcome).toBe("success")
      expect(report.searches).toBe(1)
    })

    it("carries the per-board breakdown onto a failure report", async () => {
      // A run that searched nothing still has to say so per board — that is
      // what makes "which board went quiet, and when" a log query.
      const log = vi.mocked(console.log)

      await expect(
        run({
          createScout: scoutReturning(JSON.stringify(FINDINGS), [
            failedSearch(),
          ]),
        })
      ).rejects.toThrow()

      const failure = JSON.parse(String(log.mock.calls[0]?.[0]))
      expect(failure.searchesBySource).toEqual(noSearches())
    })
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
