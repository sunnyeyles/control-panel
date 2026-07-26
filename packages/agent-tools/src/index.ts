import type { StructuredToolInterface } from "@langchain/core/tools"

import { getCurrentTime } from "./time.js"

export { getCurrentTime } from "./time.js"

/**
 * Every tool in the catalog.
 *
 * Convenient for a general-purpose agent, but not the default you should reach
 * for: a model picks worse as the tool list grows, so give an agent the tools
 * its job needs and nothing more. Import them individually
 * (`@workspace/agent-tools/time`) when you want that control.
 */
export const allTools: StructuredToolInterface[] = [getCurrentTime]
