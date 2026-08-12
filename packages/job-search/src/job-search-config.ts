import { JOB_SCOUT_MAX_LLM_CALLS } from "@workspace/agents"
import * as z from "zod"

/**
 * What a job's `config` column means — the one copy of that contract.
 *
 * `jobs.config` is deliberately untyped in `@workspace/db` — the platform stores
 * it and never reads inside it — which is what lets a second kind of job arrive
 * later with a different config and no migration.
 *
 * A package rather than a worker module, because two apps hold this contract
 * and apps do not depend on apps. A job created without `titles` and
 * `locations` is not "a job with no criteria yet": its first run is guaranteed
 * to fail with *"has a config this worker cannot read"*, having already claimed
 * and burned its slot. The dashboard's create form derives its fields from this
 * schema, so a change to the required set is a compile error rather than a run
 * that fails tomorrow morning.
 */

const nonEmpty = z.string().trim().min(1)

/**
 * The most postings a briefing may ask for.
 *
 * Not a guess at what a person can read: it is the point past which a scout
 * cannot honestly fill the brief in one run. Every posting reported has to be
 * read first, and `MAX_DETAIL_IDS` in `@workspace/agent-tools` bounds a read call
 * — so a ceiling above that would let a briefing ask for a shortlist the scout
 * has no way to have looked at.
 *
 * Exported because the form that collects the field needs to state the bound,
 * and a second copy of the number over there is a second thing to change.
 */
export const MAX_POSTINGS_PER_BRIEF = 25

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
    .max(MAX_POSTINGS_PER_BRIEF)
    .optional()
    .describe("How many postings the brief should carry at most."),
})

export type JobSearchConfig = z.infer<typeof JobSearchConfigSchema>

/**
 * Which attempt at one set of criteria a brief is for.
 *
 * A run gets a second pass when the first reported nothing and the boards were
 * genuinely answering — the money is already spent, and an empty briefing is
 * worth less than a wider one. Named rather than a boolean because it appears in
 * the run report, where `wider` says what happened and `true` would not.
 */
export type SearchPass = "first" | "wider"

/**
 * How many postings to ask for when the job does not say.
 *
 * Was 8, and it was the binding constraint on every briefing in production:
 * nothing ever writes `maxPostings`, so every run asked for eight however many
 * the boards had. One SEEK search alone returns up to 40 — the shortage was
 * this line, not the market. `MAX_DETAIL_IDS` in `@workspace/agent-tools` moved
 * with it, since a cap on reading is a cap on reporting.
 *
 * Exported so the form can say what leaving the field blank means.
 */
export const DEFAULT_MAX_POSTINGS = 20

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
 * Reading the brief, `get_posting_details`, `submit_findings`, and the message
 * it ends on. ⚠️ A scout that runs out of turns before it submits loses
 * everything it found rather than reporting less — which is why this is eight
 * rather than six: at twenty postings the shortlist exceeds `MAX_DETAIL_IDS`
 * and needs a second read call.
 */
const NON_SEARCH_TURNS = 8

/**
 * How many model calls to give the scout for one config.
 *
 * A sweep is titles × locations × boards searches, so a constant right for one
 * board silently truncates a run with three: the scout is routed to `halt`
 * mid-search and answers with what it had, which still parses as a well-formed
 * brief. `JOB_SCOUT_MAX_LLM_CALLS` stays the floor, so a one-title,
 * one-location job is unaffected.
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
 *
 * `titleExclusions` is a parameter rather than a config field because it is
 * account-wide (`posting_filters`) and applies to every briefing the user has.
 *
 * ⚠️ **Telling the scout is not what enforces it.** The worker drops matching
 * postings deterministically after the scout reports — see
 * `title-exclusions.ts`. Saying it here only saves searches on roles about to
 * be thrown away, which is a cost argument and not a correctness one.
 *
 * `pass` is which attempt this is: a `"wider"` brief reads the same criteria as
 * preferences rather than requirements, because a run reporting nothing has
 * spent its money for no briefing. Composed here so the two passes cannot
 * disagree about what the criteria say.
 */
export function toSearchBrief(
  config: JobSearchConfig,
  occurrence: Date,
  titleExclusions: readonly string[] = [],
  pass: SearchPass = "first"
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

  if (titleExclusions.length) {
    // A hard rule, separate from `exclude` above, because it *is* one: matching
    // postings are dropped whatever the scout decides. Wording it as guidance
    // would invite the model to weigh it.
    lines.push(
      `Never report a posting whose title contains any of these words: ${titleExclusions.join("; ")}. They are filtered out afterwards regardless, so reporting one wastes the slot.`
    )
  }

  if (config.sources?.length) {
    // Not an instruction to search only these — the scout searches every board
    // it has a tool for, and implying otherwise would have it report a
    // restriction it did not apply. It is context for ranking.
    lines.push(
      `Job boards the candidate follows: ${config.sources.join("; ")}. Search every board your tools reach — this list is context, not a restriction.`
    )
  }

  if (pass === "wider") {
    // Instructions about *these* criteria, not new ones: a brief that invented a
    // role title would return postings and answer the wrong question. The
    // title-exclusion line is deliberately untouched — it is enforced after the
    // scout reports either way.
    lines.push(
      "",
      "A first pass over exactly these criteria found nothing worth reporting, so search wider this time:",
      "- Treat the preferred skills and the things to rule out as preferences rather than requirements. A role that fits the title and the location is worth reporting even when it matches none of them.",
      "- Where a location returned nothing, search the wider region it sits in and remote roles in the same country as well.",
      "- Leave the freshness bound at each board's default rather than tightening it, and raise it if a search still comes back empty.",
      "- Widen the title itself only as far as an adjacent way of writing the same role — a broader seniority or a synonym the boards use. Do not search for a different job."
    )
  }

  lines.push(
    "",
    `Return at most ${config.maxPostings ?? DEFAULT_MAX_POSTINGS} postings, best match first.`
  )

  return lines.join("\n")
}
