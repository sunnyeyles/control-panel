import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createAgent } from "@workspace/agents-core"

/**
 * Taken from the tool rather than written out, so renaming the tool cannot
 * leave this looking for a name nothing emits.
 */
const TIME_TOOL_NAME = getCurrentTime.name

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

  // The fields both outcomes share, measured at the moment of the call so each
  // report gets its own duration. Built once so the two paths cannot drift.
  const common = (): RunReportFields => ({
    event: "proof-run",
    startedAt,
    durationMs: Date.now() - startedAtMs,
    llmCalls,
    toolRoundTrips,
  })

  try {
    // Exactly one tool, imported per-module rather than via `allTools`: a model
    // picks worse as the list grows, and this task needs one thing.
    const agent = createAgent({ tools: [getCurrentTime] })

    const result = await agent.invoke({
      messages: [new HumanMessage(PROOF_PROMPT)],
    })

    llmCalls = result.llmCalls
    toolRoundTrips = countTimeToolResults(result.messages)
    const answer = assertSucceeded(result.messages, toolRoundTrips)

    return emit({ ...common(), outcome: "success", answer })
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

  // This is also how a budget halt surfaces. The `halt` node answers every
  // outstanding tool call with an error ToolMessage before going to END, so a
  // run that gave up ends on a ToolMessage rather than an AI message.
  if (!final || !AIMessage.isInstance(final)) {
    throw new Error(
      `Run did not end on an AI message (last message was ${final?.getType() ?? "none"}), so it gave up rather than finishing.`
    )
  }

  // Unreachable against today's graph — the router only leaves for END once no
  // tool calls are pending. Kept because the ticket names it as a distinct
  // success condition, and it is what would catch a future graph that routed
  // to END with work outstanding.
  if ((final.tool_calls ?? []).length > 0) {
    throw new Error(
      "Run ended on an AI message with unanswered tool calls, so it did not reach END cleanly."
    )
  }

  if (toolRoundTrips === 0) {
    throw new Error(
      `Run completed no successful ${TIME_TOOL_NAME} round trip, so the tool path was never exercised.`
    )
  }

  return final.text
}
