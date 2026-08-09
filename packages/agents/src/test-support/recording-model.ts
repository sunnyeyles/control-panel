import { AIMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import type { AgentTool, ChatModelLike } from "@workspace/agents-core"

/**
 * The fake this package's suites drive agents with.
 *
 * `ChatModelLike` is a structural interface for exactly this: a fake satisfies
 * it, so a factory can be driven — through the real `createAgent`, the real
 * graph — with no provider key and no network. What `createAgent` hands to
 * `bindTools` *is* what the model may call, so recording that argument is the
 * whole tool-set assertion.
 *
 * This used to be written out per suite, on the theory that each fake should
 * stay shaped by what its suite proves. Three suites then carried it
 * byte-identical, differing only in the canned reply — which is the case that
 * theory was hedging against, so it lives here once now. It takes a reply and
 * nothing else; a suite that needs a different fake should write that fake,
 * not grow this one.
 */
export class RecordingModel implements ChatModelLike {
  /** One entry per `bindTools` call. `createAgent` makes exactly one. */
  readonly bound: AgentTool[][] = []
  /** The message lists the model was invoked with, system message first. */
  readonly seen: BaseMessage[][] = []

  constructor(private readonly reply = "OK.") {}

  bindTools(tools: AgentTool[]): {
    invoke(messages: BaseMessage[]): Promise<AIMessage>
  } {
    this.bound.push(tools)

    return {
      invoke: async (messages: BaseMessage[]): Promise<AIMessage> => {
        this.seen.push(messages)
        return new AIMessage(this.reply)
      },
    }
  }
}
