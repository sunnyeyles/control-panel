import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { Findings } from "@workspace/agents"

/**
 * The findings, verbatim, as JSON.
 *
 * Handed over as data rather than prose so the writer has no room to
 * re-interpret what was found — and so the one instruction that matters, that
 * URLs are copied rather than composed, is about a field it can see.
 */
export function toWriterPrompt(findings: Findings): string {
  return [
    "Write the brief from these findings.",
    "",
    JSON.stringify(findings, null, 2),
  ].join("\n")
}

/**
 * Check an agent finished under its own steam, and return what it said.
 *
 * Structural, never a judgement on the prose. A budget halt is what this
 * catches most often: the `halt` node answers every outstanding tool call with
 * an error before going to END, so an agent that gave up ends on a ToolMessage
 * rather than an AI message.
 *
 * The writer's only, now. The scout's answer is not its final message any more
 * — `submit_findings` captures it as it validates it — so a scout that reported
 * and then hit its budget has still reported, and failing it for how it ended
 * would throw away a perfectly good brief. What replaces this check over there
 * is stricter about the thing that matters: findings or no findings.
 */
export function finalAnswer(messages: BaseMessage[], who: string): string {
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
