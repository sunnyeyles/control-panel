import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import type { Findings, ScoutFindings } from "@workspace/agents"
import type { Artifact, ClaimedSlot, DueJob, NewPosting } from "@workspace/db"
import type { BriefStore, NewBrief, StoredBrief } from "@workspace/user-storage"
import { beforeEach, vi } from "vitest"

import type { AgentLike, AgentStreamOptions } from "./run-agent.ts"
import { runBriefing, type ScoutSessionLike } from "./run-briefing.ts"
import { SEARCH_TOOL_NAMES, type SearchAttemptLike } from "./search-results.ts"

/**
 * Shared fixtures for the `runBriefing` suite.
 *
 * The run is driven with fake agents rather than a fake model, which is what
 * the `createScout`/`createWriter` seams exist for. Every assertion is about
 * the *structure* of a run — did a search happen, did the hand-off validate, is
 * the key derived from the occurrence — never about prose, so nothing needs an
 * API key and nothing depends on what a model happens to say.
 */

export const SLOT: ClaimedSlot = {
  runId: "11111111-1111-4111-8111-111111111111",
  // 23:30 UTC: the run finishes on the 29th, but the brief is for the 28th.
  scheduledFor: new Date("2026-07-28T23:30:00.000Z"),
  nextRunAt: new Date("2026-07-29T23:30:00.000Z"),
}

export const JOB = {
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

export const POSTING_URL = "https://example.com/jobs/1"

/** The id a search gave that posting, and the only name the scout knows it by. */
export const POSTING_ID = "7f3a91c2aa10bb42"

/** What the scout reports: composed fields, and an id instead of a URL. */
export const SCOUT_FINDINGS: ScoutFindings = {
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
export const FINDINGS: Findings = {
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
export const CATALOG: Record<string, string> = { [POSTING_ID]: POSTING_URL }

/**
 * Every board at zero — the breakdown a run carries before anything searched.
 *
 * Derived from the tool list rather than written out, because the number of
 * boards is not what these tests are about: pinning it here would mean a test
 * failing the next time one is added, which is exactly the noise that teaches
 * people to update an expectation without reading it.
 */
export function noSearches(): Record<string, number> {
  return Object.fromEntries(SEARCH_TOOL_NAMES.map((name) => [name, 0]))
}

/** What a search puts in the transcript, which is not what proves it happened. */
export function searchResult(
  name = "seek_search",
  callId = "call_1"
): ToolMessage {
  return new ToolMessage({
    content: `1. [${POSTING_ID}] Senior Backend Engineer — Acme\n   listed: 2026-07-28 · Sydney`,
    tool_call_id: callId,
    name,
    status: "success",
  })
}

/**
 * A board that answered, as its own search log recorded it.
 *
 * ⚠️ **This, and not a ToolMessage, is what the run believes.** A board search
 * that fails answers the model with a *sentence* and therefore produces a
 * perfectly successful tool result, so a run reading the transcript counted a
 * dead scraper as a live search — see `search-results.ts`. These tests used to
 * express "a search worked" as a `status: "success"` message, which was the
 * broken premise stated twice.
 */
export function searched(
  toolName = "seek_search",
  results = 1,
  board = "SEEK"
): SearchAttemptLike {
  return { toolName, board, outcome: "ok", results }
}

/** A board that was called and did not answer. */
export function searchFailed(
  toolName = "seek_search",
  board = "SEEK"
): SearchAttemptLike {
  return {
    toolName,
    board,
    outcome: "failed",
    results: 0,
    message: `The ${board} search for "senior backend engineer" failed with HTTP 500. Continue with what you already have.`,
  }
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
export const streamOptions: AgentStreamOptions[] = []

export function fakeAgent(messages: BaseMessage[], llmCalls = 2): AgentLike {
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
 * A fake scout session: an agent, the catalog its searches filled, what it
 * submitted, and what its searches actually did.
 *
 * The four arrive together because the run needs all four and none is derivable
 * from the others — the messages say what the scout *did*, the findings say what
 * it *reported*, only the catalog says what an id names, and only the search log
 * says whether a board answered. Satisfying `ScoutSessionLike` outright rather
 * than by a cast is what widening that seam to a structural type bought.
 */
export function fakeSession(options: {
  findings?: ScoutFindings
  messages?: BaseMessage[]
  catalog?: Record<string, string>
  attempts?: SearchAttemptLike[]
  /** `null` ends the run on a tool result, which is what a budget halt does. */
  reply?: string | null
  llmCalls?: number
}): ScoutSessionLike {
  const entries = options.catalog ?? CATALOG
  const attempts = options.attempts ?? [searched()]

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
    searches: () => attempts,
  }
}

export function scoutReturning(
  findings: ScoutFindings | undefined = SCOUT_FINDINGS,
  attempts: SearchAttemptLike[] = [searched()]
) {
  return () => fakeSession({ findings, attempts })
}

/**
 * A different session per pass, for the runs that get two.
 *
 * The run builds a fresh session for each pass — it has to, since
 * `submit_findings` is last-write-wins and tells a scout that has reported not
 * to search again — so a test can hand back what the first pass found and then
 * what the wider one did. The last entry answers any further call.
 */
export function scoutPerPass(...sessions: ScoutSessionLike[]) {
  let calls = 0

  return () => sessions[Math.min(calls++, sessions.length - 1)]!
}

export function writerReturning(markdown: string) {
  return () => fakeAgent([new AIMessage(markdown)])
}

export let briefs: BriefStore
export let recordArtifact: (
  runId: string,
  objectKey: string
) => Promise<Artifact>
export let recordFindings: (runId: string, findings: Findings) => Promise<void>
export let recordPostings: (
  runId: string,
  postings: NewPosting[]
) => Promise<void>
export let puts: NewBrief[]
export let recorded: Array<{ runId: string; objectKey: string }>
export let kept: Array<{ runId: string; findings: Findings }>
export let tracked: Array<{ runId: string; postings: NewPosting[] }>

/** Wire the mutable stores every `runBriefing` test file shares. */
export function installRunBriefingFixtures(): void {
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
        const day = brief.occurrence
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, "/")
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

    recordFindings = async (
      runId: string,
      findings: Findings
    ): Promise<void> => {
      kept.push({ runId, findings })
    }

    recordPostings = async (
      runId: string,
      postings: NewPosting[]
    ): Promise<void> => {
      tracked.push({ runId, postings })
    }
  })
}

export function run(
  overrides: Partial<Parameters<typeof runBriefing>[0]> = {}
) {
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
