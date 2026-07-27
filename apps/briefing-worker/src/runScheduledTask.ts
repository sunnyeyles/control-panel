import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createAgent } from "@workspace/agents-core"

/** The one tool the proof task gets. Named per the tool's own `name` field. */
const TIME_TOOL_NAME = "get_current_time"

/**
 * Fixed, and UTC on purpose: it keeps the expected answer stable against DST,
 * and it forces a tool call, so a run exercises the full model → tools → model
 * cycle rather than a single completion.
 */
export const PROOF_PROMPT =
  "What is the current date and time in UTC? Use your tool, then answer in one sentence."

interface RunReportFields {
  event: "proof-run"
  startedAt: string
  durationMs: number
  llmCalls: number
  toolRoundTrips: number
}

/** A run that met every condition in {@link assertSucceeded}. */
export interface SuccessReport extends RunReportFields {
  outcome: "success"
  answer: string
}

/** Anything else. `error` carries the diagnostic detail. */
export interface FailureReport extends RunReportFields {
  outcome: "failure"
  error: string
}

/**
 * The verification artifact: one JSON line per run, on stdout, which the
 * Functions host ships to App Insights traces. A human checks the foundation
 * is alive by filtering `event == "proof-run"` over the last 24 h and
 * expecting one `outcome == "success"` row per scheduled slot — a missing row
 * means the run never started, which an exit code alone cannot tell you.
 *
 * Success and failure are separate types because the schema genuinely differs:
 * `answer` exists only when there is one, `error` only when there isn't.
 */
export type RunReport = SuccessReport | FailureReport

/**
 * Run the proof task once.
 *
 * Emits exactly one run report — on both paths, never twice, never zero times
 * — then returns it on success or rethrows on failure. The throw is the
 * authoritative signal: it is what marks the Functions invocation Failed.
 */
export async function runScheduledTask(): Promise<SuccessReport> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()

  // Read outside the try so a failure report can still carry however far the
  // run got before it broke.
  let llmCalls = 0
  let toolRoundTrips = 0

  try {
    // Exactly one tool, imported per-module rather than via `allTools`: a model
    // picks worse as the list grows, and this task needs one thing.
    const agent = createAgent({ tools: [getCurrentTime] })

    const result = await agent.invoke({
      messages: [new HumanMessage(PROOF_PROMPT)],
    })

    llmCalls = result.llmCalls
    toolRoundTrips = countTimeToolResults(result.messages)

    return emit({
      event: "proof-run",
      outcome: "success",
      startedAt,
      durationMs: Date.now() - startedAtMs,
      llmCalls,
      toolRoundTrips,
      answer: assertSucceeded(result.messages, toolRoundTrips),
    })
  } catch (error) {
    emit({
      event: "proof-run",
      outcome: "failure",
      startedAt,
      durationMs: Date.now() - startedAtMs,
      llmCalls,
      toolRoundTrips,
      error: error instanceof Error ? error.message : String(error),
    })

    throw error
  }
}

function emit<T extends RunReport>(report: T): T {
  console.log(JSON.stringify(report))
  return report
}

/** Tool results that actually worked — an error result proves nothing ran. */
function countTimeToolResults(messages: BaseMessage[]): number {
  return messages.filter(
    (message) =>
      ToolMessage.isInstance(message) &&
      message.name === TIME_TOOL_NAME &&
      message.status !== "error"
  ).length
}

/**
 * Judge the run structurally, and return the answer text if it passed.
 *
 * Deliberately never reads the model's prose for correctness: asserting on
 * English would make the foundation's health depend on phrasing. What is
 * checked is the shape of the transcript — that the graph reached `END` under
 * its own steam, and that a tool genuinely ran on the way.
 */
function assertSucceeded(
  messages: BaseMessage[],
  toolRoundTrips: number
): string {
  const final = messages.at(-1)

  if (!final || !AIMessage.isInstance(final)) {
    throw new Error(
      `Run did not end on an AI message (last message was ${final?.getType() ?? "none"}).`
    )
  }

  // Outstanding tool calls mean the graph left via the budget `halt` node
  // rather than `END` — a run that gave up, not a run that finished.
  if ((final.tool_calls ?? []).length > 0) {
    throw new Error(
      "Run ended with unanswered tool calls, so it halted on its model-call budget instead of reaching END."
    )
  }

  if (toolRoundTrips === 0) {
    throw new Error(
      `Run completed no successful ${TIME_TOOL_NAME} round trip, so the tool path was never exercised.`
    )
  }

  return final.text
}
