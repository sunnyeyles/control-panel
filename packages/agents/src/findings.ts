import * as z from "zod"

import { parseJsonAgainstSchema, schemaDescription } from "./parse-json.ts"

/**
 * The contract between the scout and the writer.
 *
 * It lives here, beside both agents, because it belongs to neither: the scout
 * produces it, the writer consumes it, and the worker validates it in between.
 * That validation is the whole point of the separation — a scraper returns
 * data, and data is the thing you can check. Prose is not.
 *
 * The scout has no structured-output channel (the graph binds tools and returns
 * messages), so the hand-off travels as JSON in the final message and is parsed
 * here. `jobScoutSchemaDescription` renders this same schema into the scout's
 * prompt, so what is asked for and what is accepted cannot drift apart.
 */

export const PostingSchema = z.object({
  title: z.string().describe("The role title, as written in the posting."),
  company: z
    .string()
    .describe(
      'The hiring organisation. Use "Unknown" only if the page genuinely does not say.'
    ),
  location: z
    .string()
    .describe('Where the role is based, including "Remote" if it is.'),
  url: z
    .url()
    .describe(
      "The link to the posting. This must be a URL a search actually returned — never one you assembled or guessed."
    ),
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
      "Bullet points from the listing itself — responsibilities, requirements, benefits — each reproduced word for word as the advertisement wrote it. Copy them or omit the field entirely; never compose, summarise, condense or paraphrase one. A line you wrote rather than copied is a fabrication, exactly as an assembled URL is."
    ),
  summary: z
    .string()
    .describe("Two or three sentences on what the role involves."),
  matchReason: z
    .string()
    .describe("One sentence on why this fits the candidate's criteria."),
})

export const FindingsSchema = z.object({
  postings: z
    .array(PostingSchema)
    .describe("The roles found, best match first. May be empty."),
  notes: z
    .string()
    .optional()
    .describe(
      "Anything the reader should know about the search itself — a source that failed, a criterion that returned nothing."
    ),
})

export type Posting = z.infer<typeof PostingSchema>
export type Findings = z.infer<typeof FindingsSchema>

/**
 * The schema as JSON Schema, for embedding in a prompt. Derived rather than
 * hand-written so the shape the scout is asked for stays identical to the shape
 * {@link parseFindings} enforces.
 */
export const jobScoutSchemaDescription: string =
  schemaDescription(FindingsSchema)

/**
 * Parse and validate the scout's final message.
 *
 * Throws rather than degrading. There is no lenient path on purpose: passing
 * unvalidated text to the writer would turn "the scout stopped following the
 * contract" into a brief that looks fine and cites nothing real, which is far
 * worse than a failed run.
 */
export function parseFindings(text: string): Findings {
  return parseJsonAgainstSchema(FindingsSchema, text, {
    producer: "scout",
    schemaName: "findings",
  })
}
