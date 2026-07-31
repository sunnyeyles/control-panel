import type { StructuredToolInterface } from "@langchain/core/tools"

import { getCurrentTime } from "./time.ts"
import { webSearch } from "./web-search.ts"

export { getCurrentTime } from "./time.ts"
export {
  tavilySearch,
  webSearch,
  type WebSearchDeps,
  type WebSearchInput,
} from "./web-search.ts"

// Deliberately absent from `allTools`: the Gmail tools need a per-user
// credential, so they exist only as a factory, composed per request at the
// caller's composition root.
export {
  createGmailTools,
  type CreateGmailToolsOptions,
  type GmailAccess,
  type ReadEmailInput,
  type SearchEmailInput,
} from "./gmail.ts"

/**
 * Every tool in the catalog.
 *
 * Convenient for a general-purpose agent, but not the default you should reach
 * for: a model picks worse as the tool list grows, so give an agent the tools
 * its job needs and nothing more. Import them individually
 * (`@workspace/agent-tools/web-search`) when you want that control.
 */
export const allTools: StructuredToolInterface[] = [getCurrentTime, webSearch]
