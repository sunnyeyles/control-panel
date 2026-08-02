import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph"
import * as z from "zod"

/**
 * The graph's shared state.
 *
 * `messages` uses the prebuilt message-aware reducer, so nodes return only the
 * messages they produced and LangGraph appends them. `llmCalls` accumulates so
 * the router can stop a runaway tool loop.
 */
export const AgentState = new StateSchema({
  messages: MessagesValue,
  llmCalls: new ReducedValue(z.number().default(0), {
    reducer: (current: number, update: number) => current + update,
  }),
})
