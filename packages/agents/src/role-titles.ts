import * as z from "zod"

import { parseJsonAgainstSchema, schemaDescription } from "./parse-json.ts"

/**
 * The contract between the role-title suggester and the form that renders it.
 *
 * It sits beside the agent rather than inside it for the reason `criteria.ts`
 * does: the suggester proposes titles, a form offers them as buttons, and
 * neither side owns the shape. What comes back is validated here before
 * anything renders it.
 *
 * ⚠️ **This is not `SearchCriteriaSchema` with two fields deleted.** The
 * profile extractor answers "what should this person search for", starting from
 * nothing; this agent answers "what else, given what they have already chosen",
 * and its whole value is in the titles the first list does not contain. Sharing
 * one schema would let a caller hand a set of adjacent titles to something
 * expecting a complete set of criteria, and the locations it did not ask for
 * would be silently empty.
 *
 * One rule the descriptions below follow that is easy to break by accident:
 * **no double quotes in a `.describe()` string.** They are rendered through
 * `JSON.stringify` into {@link roleTitleSuggestionsSchemaDescription}, which
 * escapes a quote to `\"`. The meaning survives that; the description stops
 * appearing in the prompt verbatim, and the test asserting the prompt is not a
 * second copy of the contract quietly stops proving anything.
 */

export const RoleTitleSuggestionsSchema = z.object({
  titles: z
    .array(z.string())
    .describe(
      "Role titles adjacent to the ones the candidate has already chosen — lateral moves, neighbouring specialisms, and the other words a job board uses for work this person could do. Never a restatement of a title they already have, and never a seniority the CV does not evidence. May be empty when there is nothing worth adding."
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Anything the reader should know about the suggestion itself — most usefully why a list is short or empty. Not a sales pitch for the titles above."
    ),
})

export type RoleTitleSuggestions = z.infer<typeof RoleTitleSuggestionsSchema>

/**
 * The schema as JSON Schema, for embedding in a prompt. Derived rather than
 * hand-written so the shape the suggester is asked for stays identical to the
 * shape {@link parseRoleTitleSuggestions} enforces.
 */
export const roleTitleSuggestionsSchemaDescription: string = schemaDescription(
  RoleTitleSuggestionsSchema
)

/**
 * Parse and validate the suggester's final message.
 *
 * Throws rather than degrading, like every other hand-off in this package —
 * but the consequence of a bad parse is milder here than for search criteria,
 * and it is worth being clear about why the strictness is kept anyway. A
 * suggestion is offered as buttons the user may ignore, so a failure costs one
 * click rather than a week of wrong briefs. What it must not do is render
 * *something* — a half-parsed list, an empty array standing in for an error —
 * because a row of buttons that silently lost half its entries is
 * indistinguishable from a candidate with few adjacent roles.
 */
export function parseRoleTitleSuggestions(text: string): RoleTitleSuggestions {
  return parseJsonAgainstSchema(RoleTitleSuggestionsSchema, text, {
    producer: "role-title suggester",
    schemaName: "role-title-suggestions",
  })
}
