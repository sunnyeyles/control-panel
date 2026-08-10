import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { postingId, type Findings, type ScoutFindings } from "@workspace/agents"
import type { Artifact, ClaimedSlot, DueJob, NewPosting } from "@workspace/db"
import type { BriefStore, NewBrief, StoredBrief } from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentLike, AgentStreamOptions } from "./run-agent.ts"
import { runBriefing, type ScoutSessionLike } from "./run-briefing.ts"
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

const POSTING_URL = "https://example.com/jobs/1"

/** The id a search gave that posting, and the only name the scout knows it by. */
const POSTING_ID = "7f3a91c2aa10bb42"

/** What the scout reports: composed fields, and an id instead of a URL. */
const SCOUT_FINDINGS: ScoutFindings = {
  postings: [
    {
      id: POSTING_ID,
      title: "Senior Backend Engineer",
      company: "Acme",
      location: "Sydney",
      summary: "Building things.",
      matchReason: "Matches the title and location.",
    },
  ],
}

/** The same findings once the run has resolved that id, which is what is stored. */
const FINDINGS: Findings = {
  postings: [
    {
      title: "Senior Backend Engineer",
      company: "Acme",
      location: "Sydney",
      summary: "Building things.",
      matchReason: "Matches the title and location.",
      url: POSTING_URL,
    },
  ],
}

/** The catalog a search filled, as the run's fake scout hands it over. */
const CATALOG: Record<string, string> = { [POSTING_ID]: POSTING_URL }

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
    content: `1. [${POSTING_ID}] Senior Backend Engineer — Acme\n   listed: 2026-07-28 · Sydney`,
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

/**
 * A fake scout session: an agent, the catalog its searches filled, and whatever
 * it submitted.
 *
 * The three arrive together because the run needs all three and none is
 * derivable from the others — the messages say what the scout *did*, the
 * findings say what it *reported*, and only the catalog says what an id names.
 * Satisfying `ScoutSessionLike` outright rather than by a cast is what widening
 * that seam to a structural type bought.
 */
function fakeSession(options: {
  findings?: ScoutFindings
  messages?: BaseMessage[]
  catalog?: Record<string, string>
  /** `null` ends the run on a tool result, which is what a budget halt does. */
  reply?: string | null
  llmCalls?: number
}): ScoutSessionLike {
  const entries = options.catalog ?? CATALOG

  return {
    agent: fakeAgent(
      [
        ...(options.messages ?? [searchResult()]),
        ...(options.reply === null
          ? []
          : [new AIMessage(options.reply ?? "Submitted.")]),
      ],
      options.llmCalls
    ),
    catalog: { get: (id) => (entries[id] ? { url: entries[id] } : undefined) },
    findings: () => options.findings,
  }
}

function scoutReturning(
  findings: ScoutFindings | undefined = SCOUT_FINDINGS,
  messages: BaseMessage[] = [searchResult()]
) {
  return () => fakeSession({ findings, messages })
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
    createScout: scoutReturning(),
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

  /**
   * The account-wide title filter, enforced rather than asked for.
   *
   * `config.exclude` next door is rendered into the scout's brief and the model
   * may weigh it. These assertions are about the thing that is not weighed: what
   * the writer is shown, what is stored, and what the report says was left out.
   */
  describe("excluding a posting by a word in its title", () => {
    const MID_ID = "aa11bb22cc33dd44"
    const MID_URL = "https://example.com/jobs/2"

    /** One senior role and one that is not, both really returned by a search. */
    const BOTH: ScoutFindings = {
      postings: [
        SCOUT_FINDINGS.postings[0]!,
        {
          ...SCOUT_FINDINGS.postings[0]!,
          id: MID_ID,
          title: "Backend Engineer",
        },
      ],
    }

    function runWithBoth(titleExclusions: string[]) {
      return run({
        titleExclusions,
        createScout: () =>
          fakeSession({
            findings: BOTH,
            catalog: { ...CATALOG, [MID_ID]: MID_URL },
            messages: [
              new ToolMessage({
                content: `1. [${POSTING_ID}] Senior Backend Engineer — Acme\n2. [${MID_ID}] Backend Engineer — Acme`,
                tool_call_id: "call_1",
                name: "seek_search",
                status: "success",
              }),
            ],
          }),
      })
    }

    it("keeps it out of the brief, the findings and the postings alike", async () => {
      const report = await runWithBoth(["senior"])

      // One decision, honoured in three places — a filter the writer applied
      // and the `postings` table did not would put a row on the table the brief
      // never mentions.
      expect(report.postings).toBe(1)
      expect(report.excludedPostings).toBe(1)
      expect(
        kept[0]?.findings.postings.map((posting) => posting.title)
      ).toEqual(["Backend Engineer"])
      expect(tracked[0]?.postings.map((posting) => posting.title)).toEqual([
        "Backend Engineer",
      ])
    })

    it("does not show the writer what it excluded", async () => {
      // The prompt is the findings verbatim as JSON, so a title left in it is a
      // role the brief can still be written about.
      const prompts: string[] = []

      await run({
        titleExclusions: ["senior"],
        trace: (event) => {
          if (event.type === "prompt" && event.agent === "writer") {
            prompts.push(event.text)
          }
        },
        createScout: () =>
          fakeSession({
            findings: BOTH,
            catalog: { ...CATALOG, [MID_ID]: MID_URL },
          }),
      })

      expect(prompts[0]).toContain("Backend Engineer")
      expect(prompts[0]).not.toContain("Senior Backend Engineer")
    })

    it("tells the scout, so the search is not spent on them either", async () => {
      const prompts: string[] = []

      await run({
        titleExclusions: ["senior"],
        trace: (event) => {
          if (event.type === "prompt" && event.agent === "scout") {
            prompts.push(event.text)
          }
        },
      })

      // Belt and braces. The filter above is the guarantee; this only stops the
      // scout paying for roles that are going to be thrown away.
      expect(prompts[0]).toContain("senior")
      expect(prompts[0]).toMatch(/never report a posting whose title/i)
    })

    it("matches a whole word rather than a substring", async () => {
      // The rule `@workspace/job-search` owns, reached through the run: a user
      // who blocked `ml` must not lose every HTML role, and there is nothing on
      // screen to notice it by if they do.
      const report = await runWithBoth(["ml"])

      expect(report.postings).toBe(2)
      expect(report.excludedPostings).toBe(0)
    })

    it("reports the exclusion as a step detail, and stays quiet without one", async () => {
      function detailOf(events: TraceEvent[]) {
        return events.find(
          (event) =>
            event.type === "step" &&
            event.phase === "end" &&
            event.step === "filter"
        )
      }

      const filtered: TraceEvent[] = []
      await run({
        titleExclusions: ["senior"],
        trace: (event) => filtered.push(event),
        createScout: () =>
          fakeSession({
            findings: BOTH,
            catalog: { ...CATALOG, [MID_ID]: MID_URL },
          }),
      })

      expect(detailOf(filtered)).toMatchObject({
        detail: "1 posting excluded by title",
      })

      // A run with no filter reads exactly as it did before this step existed.
      const unfiltered: TraceEvent[] = []
      await run({ trace: (event) => unfiltered.push(event) })

      expect(detailOf(unfiltered)).not.toHaveProperty("detail")
    })

    it("is not a warning, because it is the filter working", async () => {
      const report = await runWithBoth(["senior"])

      // Every other thing a run can lose is a fault, and the warning is how
      // somebody finds out. This one was asked for, so it is a count.
      expect(report.outcome).toBe("success")
      expect(report.warnings).toBeUndefined()
    })

    it("reports nothing excluded when the user has no filter", async () => {
      const report = await run()

      expect(report.excludedPostings).toBe(0)
    })
  })

  describe("when a search did not return one of the reported ids", () => {
    const REAL = SCOUT_FINDINGS.postings[0]!
    const INVENTED = {
      ...REAL,
      id: "deadbeefdeadbeef",
      title: "Staff Engineer",
    }

    /** A run reporting one posting a search returned and one it did not. */
    function runWithOneInvented() {
      return run({
        createScout: scoutReturning({ postings: [REAL, INVENTED] }),
      })
    }

    it("still writes the brief from the postings that survived", async () => {
      const report = await runWithOneInvented()

      // One unresolvable id among several costs that posting alone. Throwing
      // the run away over it would throw away the other postings, the brief,
      // and the cumulative record with them.
      expect(report.outcome).toBe("success")
      expect(report.postings).toBe(1)
      expect(puts).toHaveLength(1)
      expect(kept[0]?.findings.postings).toEqual(FINDINGS.postings)
      expect(tracked[0]?.postings).toHaveLength(1)
    })

    it("says what it left out, since nothing else ever will", async () => {
      const report = await runWithOneInvented()

      // The brief does not mention what is missing from it and the run
      // succeeded, so without this the drop is invisible in production. The
      // title rides along because an id alone identifies nothing to a person —
      // and it is the scout's own title, which is the point when what is being
      // diagnosed is a posting it may have invented outright.
      expect(report.warnings).toEqual({
        unresolvedPostings: {
          message:
            "1 posting left out of the brief: no search returned the id the scout gave.",
          postings: [{ id: INVENTED.id, title: "Staff Engineer" }],
        },
      })
    })

    it("reports the drop as a hand-off step detail", async () => {
      const events: TraceEvent[] = []
      await run({
        trace: (event) => events.push(event),
        createScout: scoutReturning({ postings: [REAL, INVENTED] }),
      })

      expect(
        events.find(
          (event) =>
            event.type === "step" &&
            event.phase === "end" &&
            event.step === "handoff"
        )
      ).toMatchObject({
        detail: "1 posting dropped — no search returned the id",
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

    it("links to the URL the board issued, not to anything reported", async () => {
      // The scout never sees a URL, so the one in the brief can only have come
      // out of the catalog. That is the whole reason the hand-off carries ids:
      // the seven production runs lost over 2026-08-05/06 were all a URL typed
      // back slightly wrong, and there is nothing left to type.
      const issued =
        "https://au.linkedin.com/jobs/view/engineer-at-acme-443814?position=58&trackingId=vwiYgy%3D%3D"

      await run({
        createScout: () =>
          fakeSession({
            findings: SCOUT_FINDINGS,
            catalog: { [POSTING_ID]: issued },
          }),
      })

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
          createScout: scoutReturning(SCOUT_FINDINGS, [failedSearch()]),
        })
      ).rejects.toThrow(/no successful search .* on any of seek_search/)
      expect(puts).toHaveLength(0)
    })

    it("no posting the scout reported came from a search", async () => {
      // Every field valid — and not one id came back from a search. A single
      // unresolvable id is a slip and costs that posting alone (see above);
      // *all* of them is a scout reporting postings it never found, and a brief
      // built from the empty remainder would cite nothing at all.
      const invented = {
        postings: [{ ...SCOUT_FINDINGS.postings[0]!, id: "deadbeefdeadbeef" }],
      }

      await expect(
        run({ createScout: scoutReturning(invented) })
      ).rejects.toThrow(/no search returned any of their ids/)
      expect(puts).toHaveLength(0)
    })

    it("the scout never submitted its findings", async () => {
      // It searched and then stopped — out of turns, or answering in prose. A
      // scout that submits an empty list has reported a result; one that never
      // submits has reported nothing, and only the second is a failed run.
      await expect(
        run({ createScout: () => fakeSession({ findings: undefined }) })
      ).rejects.toThrow(/never called submit_findings/)
      expect(puts).toHaveLength(0)
    })

    it("the scout submitted after running out of turns, and is believed", async () => {
      // The gain from capturing findings as the tool validates them rather than
      // reading the final message: a scout that reported and *then* hit its
      // budget has still reported. This used to fail the run outright.
      const halted = new ToolMessage({
        content: "Stopped: the agent reached its budget of 10 model calls.",
        tool_call_id: "call_2",
        name: "seek_search",
        status: "error",
      })

      const report = await run({
        createScout: () =>
          fakeSession({
            findings: SCOUT_FINDINGS,
            messages: [searchResult(), halted],
            reply: null,
          }),
      })

      expect(report.outcome).toBe("success")
      expect(report.postings).toBe(1)
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
        createScout: scoutReturning(SCOUT_FINDINGS, [
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
        createScout: scoutReturning(SCOUT_FINDINGS, [
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
          createScout: scoutReturning(SCOUT_FINDINGS, [failedSearch()]),
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
})
