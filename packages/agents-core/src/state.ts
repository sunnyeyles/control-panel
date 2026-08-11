import {
  MessagesValue,
  StateSchema,
  UntrackedValue,
} from "@langchain/langgraph"
import * as z from "zod"

/**
 * The graph's shared state.
 *
 * `messages` uses the prebuilt message-aware reducer, so nodes return only the
 * messages they produced and LangGraph appends them. `llmCalls` is untracked —
 * it bounds a runaway tool loop within one invoke, and must not resume from a
 * checkpointer, or turn 2 would inherit turn 1's burn.
 */
export const AgentState = new StateSchema({
  messages: MessagesValue,
  llmCalls: new UntrackedValue(z.number().default(0)),
})
