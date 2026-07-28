import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { webSearch } from "@workspace/agent-tools/web-search"
import {
  createBriefWriter,
  createJobScout,
  parseFindings,
  type Agent,
} from "@workspace/agents"
import type { ArtifactStore, ClaimedSlot, DueJob } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"

import { parseJobSearchConfig, toSearchBrief } from "./job-search-config.ts"

/**
 * One briefing run: search, compose, upload, record.
 *
 *     config → scout ⇢ findings → writer → markdown → S3 → artifacts row
 *
 * Two agents in sequence, joined by plain TypeScript rather than by a LangGraph
 * fan-out. The fan-out — several scouts over different sources, merged and
 * ranked — is a later slice, and adding it does not disturb this shape: it
 * replaces what produces `findings` and leaves everything downstream alone.
 * What matters from the start is that the scout hands over *data*, because data
 * is the thing that can be validated between the two halves.
 *
 * Platform-independent, like `run-tick.ts`. It takes the stores it writes
 * through; constructing them is `index.ts`'s job.
 */

/**
 * Taken from the tool rather than written out, so renaming the tool cannot
 * leave this looking for a name nothing emits.
 */
const WEB_SEARCH_TOOL_NAME = webSearch.name

interface RunReportFields {
  event: "briefing-run"
  startedAt: string
  durationMs: number
  jobId: string
  runId: string
  /** The slot this brief is for — not when the run happened to execute. */
  scheduledFor: string
  llmCalls: number
  /** Searches that actually returned; an error result proves nothing ran. */
  searches: number
}

/** A run that produced a brief and recorded it. */
export interface SuccessReport extends RunReportFields {
  outcome: "success"
  postings: number
  markdownBytes: number
  objectKey: string
}

/** Anything else. `error` carries the diagnostic detail. */
export interface FailureReport extends RunReportFields {
  outcome: "failure"
  error: string
}

/**
 * One JSON line per run on stdout, which the Lambda runtime ships to the
 * function's log group. It is the only record of a run that dies before it can
 * write a row, and it carries the diagnostics — search counts, model calls —
 * that nothing will ever query but a human will want when a brief looks thin.
 */
export type RunReport = SuccessReport | FailureReport

export interface RunBriefingInput {
  job: DueJob
  slot: ClaimedSlot
  briefs: BriefStore
  artifacts: ArtifactStore
  /**
   * Injected in tests, exactly as `chat-handler.ts` injects its agent. Called
   * inside the run, never at module scope: building an agent constructs a model,
   * which reads `OPENAI_API_KEY`.
   */
  createScout?: () => Agent
  createWriter?: () => Agent
}

/**
 * Run one briefing.
 *
 * Emits exactly one run report — on both paths, never twice, never zero times —
 * then returns it on success or rethrows on failure. The throw is what
 * `runTick` turns into a failed `runs` row, and ultimately into the Lambda
 * `Errors` datapoint the alarm watches.
 */
export async function runBriefing(
  input: RunBriefingInput
): Promise<SuccessReport> {
  const { job, slot, briefs, artifacts } = input
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()

  // Read outside the try so a failure report still carries however far the run
  // got before it broke — "failed after two searches" and "failed before
  // reaching the model" are different problems.
  let llmCalls = 0
  let searches = 0

  const common = (): RunReportFields => ({
    event: "briefing-run",
    startedAt,
    durationMs: Date.now() - startedAtMs,
    jobId: job.id,
    runId: slot.runId,
    scheduledFor: slot.scheduledFor.toISOString(),
    llmCalls,
    searches,
  })

  try {
    const config = parseJobSearchConfig(job.config, job.name)

    const scout = (input.createScout ?? createJobScout)()
    const scouted = await scout.invoke({
      messages: [new HumanMessage(toSearchBrief(config, slot.scheduledFor))],
    })

    llmCalls += scouted.llmCalls
    searches = countToolResults(scouted.messages, WEB_SEARCH_TOOL_NAME)

    const scoutAnswer = finalAnswer(scouted.messages, "scout")

    // No successful search means the findings, however well-formed, came from
    // the model rather than the web. Better a failed run than a confident brief
    // citing postings nobody can visit.
    if (searches === 0) {
      throw new Error(
        `The scout completed no successful ${WEB_SEARCH_TOOL_NAME} round trip, so nothing it reported came from the web.`
      )
    }

    const findings = parseFindings(scoutAnswer)

    const writer = (input.createWriter ?? createBriefWriter)()
    const written = await writer.invoke({
      messages: [new HumanMessage(toWriterPrompt(findings))],
    })

    llmCalls += written.llmCalls
    const markdown = finalAnswer(written.messages, "brief writer").trim()

    if (markdown.length === 0) {
      throw new Error("The brief writer returned an empty brief.")
    }

    // `briefId` is the run id, and the occurrence decides the partition day. Two
    // properties fall out of that. Re-executing a given run writes the same key
    // rather than a second object; and two runs never collide on
    // `artifacts.object_key`, which is UNIQUE — a same-day ad-hoc run beside a
    // scheduled one would otherwise fail on the insert rather than on anything
    // real.
    const stored = await briefs.put({
      userId: job.userId,
      briefId: slot.runId,
      occurrence: slot.scheduledFor,
      generatedAt: new Date(),
      markdown,
    })

    // Last, and deliberately so: the row is the claim that a brief exists, so it
    // is written only once the object does. The reverse order can leave a row
    // pointing at nothing.
    await artifacts.record(slot.runId, stored.key)

    return emit({
      ...common(),
      outcome: "success",
      postings: findings.postings.length,
      markdownBytes: stored.size,
      objectKey: stored.key,
    })
  } catch (error) {
    emit({
      ...common(),
      outcome: "failure",
      error: error instanceof Error ? error.message : String(error),
    })

    throw error
  }
}

function emit<T extends RunReport>(report: T): T {
  console.log(JSON.stringify(report))
  return report
}

/**
 * The findings, verbatim, as JSON.
 *
 * Handed over as data rather than prose so the writer has no room to
 * re-interpret what was found — and so the one instruction that matters, that
 * URLs are copied rather than composed, is about a field it can see.
 */
function toWriterPrompt(findings: ReturnType<typeof parseFindings>): string {
  return [
    "Write the brief from these findings.",
    "",
    JSON.stringify(findings, null, 2),
  ].join("\n")
}

/** Tool results that actually worked — an error result proves nothing ran. */
function countToolResults(messages: BaseMessage[], toolName: string): number {
  return messages.filter(
    (message) =>
      ToolMessage.isInstance(message) &&
      message.name === toolName &&
      message.status !== "error"
  ).length
}

/**
 * Check an agent finished under its own steam, and return what it said.
 *
 * Structural, never a judgement on the prose. A budget halt is what this
 * catches most often: the `halt` node answers every outstanding tool call with
 * an error before going to END, so an agent that gave up ends on a ToolMessage
 * rather than an AI message — which would otherwise reach `parseFindings` as a
 * confusing JSON error instead of the truth, that the scout ran out of turns.
 */
function finalAnswer(messages: BaseMessage[], who: string): string {
  const final = messages.at(-1)

  if (!final || !AIMessage.isInstance(final)) {
    throw new Error(
      `The ${who} did not end on an AI message (last message was ${final?.getType() ?? "none"}), so it gave up rather than finishing. It may have exhausted its model call budget.`
    )
  }

  if ((final.tool_calls ?? []).length > 0) {
    throw new Error(
      `The ${who} ended with unanswered tool calls, so it did not reach END cleanly.`
    )
  }

  return final.text
}
