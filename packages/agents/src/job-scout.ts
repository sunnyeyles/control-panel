import { webSearch } from "@workspace/agent-tools/web-search"
import {
  createAgent,
  type Agent,
  type AgentTool,
  type CreateAgentOptions,
} from "@workspace/agents-core"

import { jobScoutSchemaDescription } from "./findings.ts"

/**
 * Enough turns to search several times and then answer.
 *
 * The runtime default of 10 is sized for a question with one tool round trip.
 * A scout is expected to make a handful of focused searches — one per role
 * title, per location, per source — and each costs a model call, so the default
 * would divert it to `halt` mid-search and produce a partial answer that still
 * looks well-formed.
 */
export const JOB_SCOUT_MAX_LLM_CALLS = 10

export const JOB_SCOUT_SYSTEM_PROMPT = [
  "You find real, currently-open job postings that match a candidate's criteria.",
  "",
  "How to search: make several focused searches rather than one broad one — vary the role title, the location, and the source. Prefer recent results; a posting from last year is not open. You may restrict a search to a specific job board when that helps.",
  "",
  "What counts as a finding: a page that is an actual job posting. Aggregator index pages, salary guides, blog posts about hiring, and expired listings are not findings — leave them out rather than padding the list.",
  "",
  "Never invent a posting, and never invent or repair a URL. Every URL you report must be one a search returned to you verbatim. If you found nothing worth reporting, return an empty list and say why in `notes`. An empty, honest result is a success; a fabricated one is not.",
  "",
  "Your final message must be JSON and nothing else — no commentary before it, no explanation after it, no code fence. It must match this schema:",
  "",
  jobScoutSchemaDescription,
].join("\n")

export interface CreateJobScoutOptions extends Omit<
  CreateAgentOptions,
  "tools"
> {
  /** Appended to the search tool the scout already carries. */
  extraTools?: AgentTool[]
}

/**
 * The scout: searches, and returns findings.
 *
 * It carries the search tool and nothing else — deliberately, on two counts. A
 * model picks worse as its tool list grows, so it gets the one tool its job
 * needs; and having no way to write anything is what makes "a scraper returns
 * data and performs no side effects" a structural property rather than a rule
 * in a prompt someone can talk it out of.
 *
 * A factory rather than a ready-made instance, like every agent here: building
 * one constructs a model, which reads `OPENAI_API_KEY` and throws without it.
 */
export function createJobScout(options: CreateJobScoutOptions = {}): Agent {
  const {
    extraTools = [],
    systemPrompt = JOB_SCOUT_SYSTEM_PROMPT,
    maxLlmCalls = JOB_SCOUT_MAX_LLM_CALLS,
    ...rest
  } = options

  return createAgent({
    ...rest,
    systemPrompt,
    maxLlmCalls,
    tools: [webSearch, ...extraTools],
  })
}
