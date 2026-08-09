import { JOB_SCOUT_MAX_LLM_CALLS } from "@workspace/agents"
import * as z from "zod"

/**
 * What a job's `config` column means — the one copy of that contract.
 *
 * `jobs.config` is deliberately untyped in `@workspace/db` — the platform
 * stores it and never reads inside it — so the interpretation belongs to
 * whatever writes or runs the job. Keeping the schema out of the database
 * package is what lets a second kind of job arrive later with a completely
 * different config and no migration.
 *
 * A package rather than a worker module, because two apps hold this contract
 * and apps do not depend on apps. The worker requires `titles` and
 * `locations`, so a job created without them is not "a job with no criteria
 * yet" — it is a job whose first run is guaranteed to fail with *"has a
 * config this worker cannot read"*, having already claimed and burned its
 * slot. While the schema lived in the worker, the dashboard's create form
 * carried a knowing partial copy of it; now the form derives its fields from
 * this schema, and a change to the required set is a compile error over
 * there rather than a run that fails tomorrow morning.
 */

const nonEmpty = z.string().trim().min(1)

export const JobSearchConfigSchema = z.object({
  titles: z
    .array(nonEmpty)
    .min(1)
    .describe('Role titles to search for, e.g. "senior backend engineer".'),
  locations: z
    .array(nonEmpty)
    .min(1)
    .describe('Where to look, e.g. "Sydney" or "Remote (Australia)".'),
  keywords: z
    .array(nonEmpty)
    .optional()
    .describe("Technologies or specialisms that make a role a better match."),
  exclude: z
    .array(nonEmpty)
    .optional()
    .describe("Things that rule a role out, e.g. an industry or a seniority."),
  sources: z
    .array(nonEmpty)
    .optional()
    .describe(
      'Job boards the candidate follows, e.g. ["seek.com.au"]. Context for the scout, not a filter — it searches every board its tools reach whatever this says.'
    ),
  maxPostings: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("How many postings the brief should carry at most."),
})

export type JobSearchConfig = z.infer<typeof JobSearchConfigSchema>

/** How many postings to ask for when the job does not say. */
export const DEFAULT_MAX_POSTINGS = 8

/**
 * The hard ceiling on a scout's model calls, whatever the config asks for.
 *
 * A budget is not a quality dial: every extra call buys another search, and
 * another search buys another actor run and another set of candidates the scout
 * still has to reason over. A configuration wide enough to need more than this
 * wants fewer results per search, or splitting into two jobs — and either way
 * somebody should notice, which a truncated run makes them do.
 */
const MAX_SCOUT_LLM_CALLS = 40

/**
 * The turns in a scout run that are not searches.
 *
 * Reading the brief, reading the shortlist back out of the catalog with
 * `get_posting_details`, calling `submit_findings`, and the one short message it
 * ends on. Was three, when a run was searches-then-answer; reading is its own
 * pass now, and a scout that runs out of turns before it can submit loses
 * everything it found rather than reporting less.
 */
const NON_SEARCH_TURNS = 6

/**
 * How many model calls to give the scout for one config.
 *
 * A sweep is titles × locations × boards searches, so the constant that was
 * right for one board silently truncates a run with three: the scout is routed
 * to `halt` mid-search and answers with whatever it had, which still parses as
 * a well-formed brief. Sizing the budget to the work is what stops a run
 * quietly covering less than it was asked to.
 *
 * {@link NON_SEARCH_TURNS} covers the rest of the run.
 * `JOB_SCOUT_MAX_LLM_CALLS` stays the floor, so a one-title, one-location job is
 * unaffected by this existing. In practice the budget is slack rather than tight
 * — the model issues several tool calls in one turn, and parallel calls cost one
 * call between them.
 *
 * `boardCount` is passed rather than read here so the caller stays the single
 * place that knows which search tools the scout carries.
 */
export function scoutLlmCallBudget(
  config: JobSearchConfig,
  boardCount: number
): number {
  const searches = config.titles.length * config.locations.length * boardCount

  return Math.min(
    Math.max(searches + NON_SEARCH_TURNS, JOB_SCOUT_MAX_LLM_CALLS),
    MAX_SCOUT_LLM_CALLS
  )
}

/**
 * Read the job's config, or fail the run.
 *
 * A job whose config cannot be understood has nothing sensible to fall back to:
 * searching for a default set of roles would spend the same money to produce a
 * brief for nobody. The error names the job so the row is findable.
 */
export function parseJobSearchConfig(
  config: unknown,
  jobName: string
): JobSearchConfig {
  const result = JobSearchConfigSchema.safeParse(config)

  if (!result.success) {
    throw new Error(
      `Job "${jobName}" has a config this worker cannot read: ${z.prettifyError(result.error)}`
    )
  }

  return result.data
}

/**
 * Turn the config into the scout's instructions.
 *
 * A list rather than a paragraph: each criterion stays separately addressable,
 * which is what lets the scout run one search per title and per location rather
 * than collapsing everything into a single query.
 */
export function toSearchBrief(
  config: JobSearchConfig,
  occurrence: Date
): string {
  const lines = [
    `Today is ${occurrence.toISOString().slice(0, 10)}. Find open job postings matching this candidate's criteria.`,
    "",
    `Role titles: ${config.titles.join("; ")}`,
    `Locations: ${config.locations.join("; ")}`,
  ]

  if (config.keywords?.length) {
    lines.push(
      `Preferred skills and technologies: ${config.keywords.join("; ")}`
    )
  }

  if (config.exclude?.length) {
    lines.push(`Rule out anything matching: ${config.exclude.join("; ")}`)
  }

  if (config.sources?.length) {
    // Not an instruction to search only these: the scout searches every board
    // it has a tool for regardless, and saying otherwise would have it report a
    // restriction it did not apply. The list is here because knowing where a
    // candidate already looks is worth something when ranking.
    lines.push(
      `Job boards the candidate follows: ${config.sources.join("; ")}. Search every board your tools reach — this list is context, not a restriction.`
    )
  }

  lines.push(
    "",
    `Return at most ${config.maxPostings ?? DEFAULT_MAX_POSTINGS} postings, best match first.`
  )

  return lines.join("\n")
}
