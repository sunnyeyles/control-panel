import * as z from "zod"

import { parseJsonAgainstSchema, schemaDescription } from "./parse-json.ts"

/**
 * The contract between the profile extractor and whatever runs a search.
 *
 * It lives here, beside the extractor rather than inside it, for the same
 * reason `findings.ts` sits beside the scout: it belongs to neither side. The
 * extractor proposes criteria, a caller stores them and later hands them to a
 * scout, and this module is what says whether what came back is usable. Reading
 * a CV is the one step in the pipeline with no source to check against — there
 * is no URL to click, no advertisement to re-fetch — so the shape of the answer is
 * the only thing that can be verified, and it is verified here.
 *
 * The extractor has no structured-output channel (the graph binds tools and
 * returns messages), so the hand-off travels as JSON in the final message and
 * is parsed here. `criteriaSchemaDescription` renders this same schema into the
 * extractor's prompt, so what is asked for and what is accepted cannot drift
 * apart.
 *
 * One rule the descriptions below follow that is easy to break by accident:
 * **no double quotes in a `.describe()` string.** They are rendered through
 * `JSON.stringify` into {@link criteriaSchemaDescription}, which escapes a
 * quote to `\"`. The meaning survives that, but the description stops appearing
 * in the prompt verbatim, and the test asserting the prompt is not a second
 * copy of the contract quietly stops proving anything.
 */

export const SearchCriteriaSchema = z.object({
  titles: z
    .array(z.string())
    .min(1)
    .describe(
      "Role titles to search for — the roles this candidate could plausibly hold next, given the roles they have actually held and the seniority the CV evidences. At least one. Not a restatement of their most recent role title alone, and never a seniority the CV does not support."
    ),
  locations: z
    .array(z.string())
    .describe(
      "Where the candidate wants to work, but only if the CV states it — a current city, a stated preference, or an explicit statement that they work remotely. Leave it empty when the CV states none; a guess from an area code or a university is an invented fact about where someone will work."
    ),
  keywords: z
    .array(z.string())
    .describe(
      "Technologies, tools and specialisms the CV actually names, used to sharpen a search. May be empty. A technology absent from the CV is one the candidate has not claimed."
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Anything the reader should know about the extraction itself — that the CV states no location, that the seniority was ambiguous, that a section was unreadable."
    ),
})

export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>

/**
 * The schema as JSON Schema, for embedding in a prompt. Derived rather than
 * hand-written so the shape the extractor is asked for stays identical to the
 * shape {@link parseSearchCriteria} enforces — add a field here and the prompt
 * asks for it with no second edit.
 */
export const criteriaSchemaDescription: string =
  schemaDescription(SearchCriteriaSchema)

/**
 * Parse and validate the extractor's final message.
 *
 * Throws rather than degrading, and there is no lenient path on purpose. These
 * criteria become what the system searches for on the user's behalf, on a
 * cadence, without them watching. A half-understood extraction that quietly
 * fills in a search does not announce itself — it comes back as briefs full of
 * the wrong roles, or of nothing at all, with no way to tell that from a quiet
 * market. A visible failure is strictly better: the CV is still there, and the
 * extraction can simply be run again.
 */
export function parseSearchCriteria(text: string): SearchCriteria {
  return parseJsonAgainstSchema(SearchCriteriaSchema, text, {
    producer: "profile extractor",
    schemaName: "search-criteria",
  })
}
