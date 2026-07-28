import * as z from "zod"

/**
 * What a job's `config` column means to *this* worker.
 *
 * `jobs.config` is deliberately untyped in `@workspace/db` — the platform
 * stores it and never reads inside it — so the interpretation belongs to
 * whatever runs the job, which is here. Keeping the schema out of the database
 * package is what lets a second kind of job arrive later with a completely
 * different config and no migration.
 *
 * This is also the seam the resume-extraction stage will eventually write to:
 * today a person fills these fields in by hand, later a profile extractor
 * derives them from an uploaded resume, and nothing downstream of here changes.
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
      'Domains to prefer, e.g. ["seek.com.au"]. Omit for the open web.'
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
    lines.push(
      `Prefer these job boards, but do not search them exclusively: ${config.sources.join("; ")}`
    )
  }

  lines.push(
    "",
    `Return at most ${config.maxPostings ?? DEFAULT_MAX_POSTINGS} postings, best match first.`
  )

  return lines.join("\n")
}
