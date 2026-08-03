import { seekSearch } from "@workspace/agent-tools/seek-search"
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
 * title and location — and each costs a model call, so the default would
 * divert it to `halt` mid-search and produce a partial answer that still
 * looks well-formed.
 */
export const JOB_SCOUT_MAX_LLM_CALLS = 10

export const JOB_SCOUT_SYSTEM_PROMPT = [
  "You find real, currently-open job postings that match a candidate's criteria, by searching SEEK's live listings.",
  "",
  'How to search: make one focused search per role title and location rather than one broad one. Results arrive newest first with their listing dates; keep daysOld tight when recency matters. Pass locations the way SEEK writes them, e.g. "Sydney NSW" or "All Australia".',
  "",
  "What counts as a finding: a returned posting whose title, location and description genuinely fit the criteria. Filter rather than pad — sharing a keyword is not a match. A criterion your searches cannot express, such as a job board you cannot reach, belongs in `notes` rather than in guesswork.",
  "",
  "Never invent a posting, and never invent or repair a URL. Every URL you report must be one a search returned to you verbatim. If you found nothing worth reporting, return an empty list and say why in `notes`. An empty, honest result is a success; a fabricated one is not.",
  "",
  "Your final message must be JSON and nothing else — no commentary before it, no explanation after it, no code fence. It must match this schema:",
  "",
  jobScoutSchemaDescription,
].join("\n")

/**
 * The boards the scout searches, as the tools that search them.
 *
 * Exported because the worker has to know which tool results count as evidence
 * that a live search happened. A list maintained separately over there would
 * drift the first time a board is added here, and it would drift *silently* —
 * the worker would under-count rather than fail, which is the failure mode the
 * search count exists to catch in the first place.
 *
 * `extraTools` is deliberately not part of this. A caller appending a tool is
 * not adding a job board, and nothing a caller passes should be able to satisfy
 * the worker's "something actually searched" check.
 */
export const JOB_SCOUT_SEARCH_TOOLS: readonly AgentTool[] = [seekSearch]

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
    tools: [...JOB_SCOUT_SEARCH_TOOLS, ...extraTools],
  })
}
