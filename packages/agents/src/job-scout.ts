import {
  createPostingCatalog,
  type PostingCatalog,
} from "@workspace/agent-tools/posting-catalog"
import { createPostingDetails } from "@workspace/agent-tools/posting-details"
import {
  createSearchLog,
  type SearchAttempt,
} from "@workspace/agent-tools/search-log"
import { createAgent, type Agent } from "@workspace/agents-core"

import type { ExtraToolsAgentOptions } from "./agent-options.ts"
import type { ScoutFindings } from "./findings.ts"
import { JOB_BOARDS, JOB_SCOUT_SEARCH_TOOL_NAMES } from "./job-boards.ts"
import { postingId } from "./posting-id.ts"
import { createSubmitFindings } from "./submit-findings.ts"

export { JOB_SCOUT_SEARCH_TOOL_NAMES }

/**
 * Enough turns to search a few times, read a shortlist, and report — the floor,
 * not the whole answer.
 *
 * The runtime default of 5 is sized for a question with one tool round trip.
 * A scout is expected to make a handful of focused searches — one per role
 * title, location and board — and each costs a model call, so the default would
 * divert it to `halt` mid-search and produce a partial answer that still looks
 * well-formed.
 *
 * A sweep is titles × locations × boards, so this cannot be sized here: what a
 * config actually needs is known to whoever read it. The worker computes a
 * budget from that and passes it as `maxLlmCalls`, and this is where it starts
 * from.
 */
export const JOB_SCOUT_MAX_LLM_CALLS = 10

export const JOB_SCOUT_SYSTEM_PROMPT = [
  "You find real, currently-open job postings that match a candidate's criteria, by searching job boards' live listings.",
  "",
  "Work in three passes. Search every board, for every role title and location. Then read the advertisements for the postings worth considering. Then report what you found. Do not report before you have read; a teaser is enough to shortlist a role and never enough to describe one.",
  "",
  "Searching: each board tool reaches one board's inventory and no other, so a role listed on one and not another is invisible until you call that tool. Run each board's tool for each role title before you decide anything about what you have found, even when an early search already looks like enough. It is not enough — it is one board. Make one focused search per role title, location and board rather than one broad one, and write each location the way the tool you are calling asks for it; the boards spell places differently and each tool's schema says which. Only SEEK returns its results newest first, so read each posting's listing date rather than trusting its position, and keep daysOld tight when recency matters.",
  "",
  "Reading: a search result gives you an id in brackets, a listing date and a teaser. That is deliberately not enough to judge a role on. Collect the ids that look plausible across every board and pass them to get_posting_details in as few calls as you can — it returns the advertisements themselves, and it is the only place you can read one or copy a line from one. It takes a bounded number of ids per call, so a longer shortlist is a second call rather than a shorter shortlist. The experience an advertisement asks for is read there too, off the advertisement's own words and never off a teaser: copy the phrase as it is written, and where a description states none, leave the field out rather than reading one off the title's seniority.",
  "",
  "Reporting: call submit_findings once, naming each posting by its id. What counts as a finding is a posting whose title, location and description genuinely fit the criteria — filter rather than pad, because sharing a keyword is not a match. A criterion your searches cannot express belongs in `notes` rather than in guesswork, but never write that a board was unavailable when you hold a tool for it and did not call it. If you found nothing worth reporting, submit an empty list and say why in `notes`. An empty, honest result is a success; a padded one is not.",
  "",
  "You never see or handle a posting's URL — the id is how a posting is named, and the link is filled in from it afterwards. So never invent an id, and never report one a search did not return to you: it names nothing, and the posting is dropped along with everything you wrote about it.",
].join("\n")

export type CreateJobScoutOptions = ExtraToolsAgentOptions

/**
 * One scout, and the three pieces of per-run state its tools write into.
 *
 * The agent alone is no longer enough to drive a run: what it reports are ids,
 * and resolving them needs the catalog those ids came from; whether to believe
 * any of it needs the log of what was searched. Returning them together is what
 * keeps a caller from having to build each one, remember to pass the same
 * instance to every tool, and hold it for afterwards.
 */
export interface JobScoutSession {
  agent: Agent
  /** Every posting this run's searches returned, keyed by the id they rendered. */
  catalog: PostingCatalog
  /** What the scout reported, or `undefined` if it never called `submit_findings`. */
  findings(): ScoutFindings | undefined
  /**
   * Every search this session attempted, and whether the board answered.
   *
   * The transcript cannot answer that — a board that failed returns a sentence,
   * which is a successful ToolMessage carrying bad news — so a caller that reads
   * "did anything actually get searched" off the messages counts a dead scraper
   * as a search. See `search-log.ts`.
   */
  searches(): readonly SearchAttempt[]
}

/**
 * The scout: searches, reads, and reports findings.
 *
 * It carries the board search tools, a reader for what they returned, and the
 * one tool it reports through — deliberately, on two counts. A model picks worse
 * as its tool list grows, so it gets the tools its job needs and no others; and
 * having no way to write anything *outside the run* is what makes "a scraper
 * returns data and performs no side effects" a structural property rather than a
 * rule in a prompt someone can talk it out of. `submit_findings` does not weaken
 * that: it writes to a variable this function owns, and reaches nothing else.
 *
 * The catalog's identity function is `postingId`, passed in from here because
 * `@workspace/agent-tools` must not depend on this package — see
 * `posting-catalog.ts`. That is what makes an id in a search result the same id
 * the `postings` table has used all along.
 *
 * Board search tools come from {@link JOB_BOARDS}: one `createSearch` per row,
 * so adding a board is an edit to that table rather than a second list here.
 * {@link JOB_SCOUT_SEARCH_TOOL_NAMES} is derived from the same table and
 * re-exported for the worker's per-board breakdown.
 *
 * A factory rather than a ready-made instance, like every agent here: building
 * one constructs a model, which reads `OPENAI_API_KEY` and throws without it.
 */
export function createJobScout(
  options: CreateJobScoutOptions = {}
): JobScoutSession {
  const {
    extraTools = [],
    systemPrompt = JOB_SCOUT_SYSTEM_PROMPT,
    maxLlmCalls = JOB_SCOUT_MAX_LLM_CALLS,
    ...rest
  } = options

  const catalog = createPostingCatalog({ idFor: (url) => postingId({ url }) })
  const log = createSearchLog()
  const submit = createSubmitFindings()

  const agent = createAgent({
    ...rest,
    systemPrompt,
    maxLlmCalls,
    tools: [
      ...JOB_BOARDS.map((board) => board.createSearch(catalog, log)),
      createPostingDetails(catalog),
      submit.tool,
      ...extraTools,
    ],
  })

  return { agent, catalog, findings: submit.submitted, searches: log.attempts }
}
