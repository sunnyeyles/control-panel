import { AIMessage, ToolMessage } from "@langchain/core/messages"
import type { Agent } from "@workspace/agents"
import type {
  Artifact,
  ArtifactStore,
  ClaimedSlot,
  DueJob,
} from "@workspace/db"
import type { BriefStore, NewBrief, StoredBrief } from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { runBriefing } from "./run-briefing.ts"

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

const JOB: DueJob = {
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
}

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

/** A successful search result — what proves the scout actually reached the web. */
function searchResult(): ToolMessage {
  return new ToolMessage({
    content: "1. Senior Backend Engineer\n   https://example.com/jobs/1",
    tool_call_id: "call_1",
    name: "web_search",
    status: "success",
  })
}

/**
 * A fake agent. `runBriefing` only invokes it and reads `messages`/`llmCalls`,
 * so a cast is honest here — building a real compiled graph would test
 * LangGraph rather than this file.
 */
function fakeAgent(messages: unknown[], llmCalls = 2): Agent {
  return {
    invoke: async () => ({ messages, llmCalls }),
  } as unknown as Agent
}

function scoutReturning(text: string, tools: ToolMessage[] = [searchResult()]) {
  return () => fakeAgent([...tools, new AIMessage(text)])
}

function writerReturning(markdown: string) {
  return () => fakeAgent([new AIMessage(markdown)])
}

let briefs: BriefStore
let artifacts: ArtifactStore
let puts: NewBrief[]
let recorded: Array<{ runId: string; objectKey: string }>

beforeEach(() => {
  puts = []
  recorded = []
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

  artifacts = {
    record: async (runId: string, objectKey: string): Promise<Artifact> => {
      recorded.push({ runId, objectKey })
      return { id: "a", runId, objectKey, createdAt: new Date() }
    },
    forRun: async () => [],
    latestForJob: async () => undefined,
  }
})

function run(overrides: Partial<Parameters<typeof runBriefing>[0]> = {}) {
  return runBriefing({
    job: JOB,
    slot: SLOT,
    briefs,
    artifacts,
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
        name: "web_search",
        status: "error",
      })

      await expect(
        run({
          createScout: scoutReturning(JSON.stringify(FINDINGS), [failedSearch]),
        })
      ).rejects.toThrow(/no successful web_search round trip/)
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
})
