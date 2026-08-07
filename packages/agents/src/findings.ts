import * as z from "zod"

/**
 * The contract between the scout and the writer.
 *
 * It lives here, beside both agents, because it belongs to neither: the scout
 * produces it, the writer consumes it, and the worker validates it in between.
 * That validation is the whole point of the separation — a scraper returns
 * data, and data is the thing you can check. Prose is not.
 *
 * ⚠️ **There are two shapes here, and they differ by one field.** The scout
 * reports a {@link ScoutPosting}, which names a posting by the `id` a search
 * gave it. The worker resolves that id against the run's posting catalog and
 * stores a {@link Posting}, which carries the `url` the board issued. Everything
 * downstream — the brief writer, the `postings` table, the dashboard, the cover
 * letter — reads the second and has never heard of the first.
 *
 * Splitting them removes a class of failure rather than guarding against it. A
 * URL the model never sees is a URL it cannot mistype, and the seven production
 * runs lost to mistyping one are recorded in the worker's `resolve-postings.ts`.
 * It also makes fabrication structural rather than comparative: an id no search
 * returned resolves to nothing, so there is no posting to report.
 *
 * {@link ScoutFindingsSchema} is the argument schema of the `submit_findings`
 * tool (`submit-findings.ts`), so the provider validates the hand-off and a
 * model that gets it wrong is told so and retries — where a malformed final
 * message used to fail the entire run.
 */

/**
 * What the scout composes about a posting, which is everything except which
 * posting it is.
 *
 * Extracted so the reported and the stored shape cannot drift: both extend this,
 * and neither restates a word of it.
 */
const PostingFieldsSchema = z.object({
  title: z.string().describe("The role title, as written in the posting."),
  company: z
    .string()
    .describe(
      'The hiring organisation. Use "Unknown" only if the page genuinely does not say.'
    ),
  location: z
    .string()
    .describe('Where the role is based, including "Remote" if it is.'),
  postedAt: z
    .string()
    .optional()
    .describe(
      "When the role was posted, if the page states it. Omit rather than estimate."
    ),
  highlights: z
    .array(z.string())
    .optional()
    .describe(
      "Bullet points from the listing itself — responsibilities, requirements, benefits — each reproduced word for word as the advertisement wrote it. Copy them from the description you read with get_posting_details, or omit the field entirely; never compose, summarise, condense or paraphrase one. A line you wrote rather than copied is a fabrication."
    ),
  summary: z
    .string()
    .describe("Two or three sentences on what the role involves."),
  matchReason: z
    .string()
    .describe("One sentence on why this fits the candidate's criteria."),
})

/** Shared by both findings shapes, so it is worded once. */
const notesField = z
  .string()
  .optional()
  .describe(
    "Anything the reader should know about the search itself — a source that failed, a criterion that returned nothing."
  )

/** A posting as the scout reports it: named by id, with no URL anywhere. */
export const ScoutPostingSchema = PostingFieldsSchema.extend({
  id: z
    .string()
    .describe(
      "The posting's id, exactly as a search result gave it in brackets — e.g. 7f3a91c2. It must be an id a search returned to you in this run: that is the only way to name a posting, and an id nothing returned is dropped along with everything you wrote about it."
    ),
})

export const ScoutFindingsSchema = z.object({
  postings: z
    .array(ScoutPostingSchema)
    .describe("The roles found, best match first. May be empty."),
  notes: notesField,
})

/**
 * A posting as everything downstream reads it: named by the URL the board
 * issued, which the worker fills in from the id the scout reported.
 */
export const PostingSchema = PostingFieldsSchema.extend({
  url: z
    .url()
    .describe(
      "The link to the posting, as the board issued it. Resolved from the reported id rather than copied by any model."
    ),
})

export const FindingsSchema = z.object({
  postings: z
    .array(PostingSchema)
    .describe("The roles found, best match first. May be empty."),
  notes: notesField,
})

export type ScoutPosting = z.infer<typeof ScoutPostingSchema>
export type ScoutFindings = z.infer<typeof ScoutFindingsSchema>
export type Posting = z.infer<typeof PostingSchema>
export type Findings = z.infer<typeof FindingsSchema>

/**
 * Parse and validate stored findings.
 *
 * Deliberately not `parseJsonAgainstSchema`, which the other agents share.
 * That helper is about an agent's *final message* — it forgives a code fence and
 * says so in its errors — and this stopped being one when the hand-off became a
 * tool call. What it reads now is JSON this platform wrote itself: the `runs`
 * row, or the file the local harness leaves beside a brief. Borrowing the
 * agent-output pipeline for that would put "the scout's final message" in an
 * error message about a file on disk.
 *
 * Throws rather than degrading, which has not changed: findings that do not
 * match the schema are findings whose provenance is unknown, and anything built
 * on them would look fine and cite nothing real.
 */
export function parseFindings(text: string): Findings {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Stored findings were not JSON (${message}). They began: ${text.slice(0, 200)}`
    )
  }

  const result = FindingsSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Stored findings do not match the findings schema: ${z.prettifyError(result.error)}`
    )
  }

  return result.data
}
