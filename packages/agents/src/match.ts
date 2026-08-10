import * as z from "zod"

import { CandidateProfileSchema } from "./cover-letter.ts"
import { parseJsonAgainstSchema, schemaDescription } from "./parse-json.ts"
import { toPostingRequestPrompt } from "./posting-prompt.ts"
import { StoredPostingSchema } from "./stored-posting.ts"

/**
 * The contract for one posting-against-resume match.
 *
 * The same arrangement as `cover-letter.ts` and `tailored-resume.ts`: the caller
 * assembles a request out of a Posting it holds and the candidate's own
 * document, and this module says what the model is asked and what will be
 * accepted back. The agent itself is a prompt and an empty tool set.
 *
 * ⚠️ **A `matchReason` and a match are different things and neither replaces
 * the other.** `matchReason` is one sentence the scout wrote about the
 * *criteria* it was handed — titles, locations, keywords — and criteria are a
 * lossy projection of a person. This is a judgement about the CV itself, which
 * is the thing that answers whether to apply. The two live side by side, and a
 * Posting somebody added by pasting a link has the second and not the first.
 *
 * Everything here is pure. Nothing reads the environment and nothing reaches the
 * network, so what is refused and what is carried through verbatim are testable
 * without a provider key.
 *
 * The same rule `criteria.ts` states applies to every `.describe()` below:
 * **no double quotes**, because they are rendered through `JSON.stringify` into
 * {@link matchSchemaDescription} and would reach the prompt escaped.
 */

/**
 * The bounds are inclusive and the type is an integer, both enforced twice.
 *
 * Once here, where a model's answer is parsed, and once in the migration as a
 * `CHECK` on `match_score`. That is not belt-and-braces: the column is written
 * by a Server Action, and a bound the database does not hold is a bound that
 * survives exactly as long as every future caller remembers it.
 */
export const MIN_MATCH_SCORE = 0
export const MAX_MATCH_SCORE = 100

export const PostingMatchSchema = z.object({
  score: z
    .number()
    .int()
    .min(MIN_MATCH_SCORE)
    .max(MAX_MATCH_SCORE)
    .describe(
      "How well the candidate's own document evidences what this advertisement asks for, from 0 to 100, using the bands you were given. A whole number."
    ),
  reason: z
    .string()
    .describe(
      "One or two sentences naming what lines up and what does not. Specific: the requirement, and the thing in the CV that answers it or the absence of one. Not a restatement of the score."
    ),
  gaps: z
    .array(z.string())
    .describe(
      "The requirements this advertisement stated that the CV does not evidence, one short phrase each. May be empty when the CV evidences everything stated. Never a general weakness, never advice, and never a requirement the advertisement did not state."
    ),
})

export type PostingMatch = z.infer<typeof PostingMatchSchema>

/**
 * The schema as JSON Schema, for embedding in the assessor's prompt. Derived
 * rather than hand-written so the shape asked for and the shape accepted cannot
 * drift — see `criteria.ts`, which does the same for the same reason.
 */
export const matchSchemaDescription: string =
  schemaDescription(PostingMatchSchema)

export const MatchRequestSchema = z.object({
  // The *stored* shape, as the letter and the rewrite take: a Posting added by
  // pasting a link carries no `matchReason`, and it is exactly the Posting most
  // worth scoring — nobody matched it against anything on the way in.
  posting: StoredPostingSchema,
  profile: CandidateProfileSchema,
})

export type MatchRequest = z.infer<typeof MatchRequestSchema>

/**
 * The prompt, built from the request and nothing else.
 *
 * The body — the posting block, the quoted-material fence around `highlights`,
 * the CV last and verbatim — lives in `posting-prompt.ts` and holds its
 * properties for all three features built on it. What belongs to *this* one is
 * the wording: the document is neither a source to write from nor a thing to
 * rewrite, it is the evidence the advertisement is being weighed against.
 */
export function toMatchPrompt(request: MatchRequest): string {
  return toPostingRequestPrompt(request, {
    opening: "Score how well I match the posting below, and say why.",
    backgroundHeading: "## My resume",
    backgroundIntro:
      "This is my own document, reproduced exactly. It is the only evidence of what I have done, and anything it does not say is something I have not claimed:",
  })
}

/**
 * Parse and validate the assessor's final message.
 *
 * Throws rather than degrading, for the reason `parseSearchCriteria` does. What
 * this produces is a number a person sorts their whole list by, and a
 * half-understood answer does not announce itself — it comes back as a
 * plausible score on the wrong posting. A visible failure is strictly better:
 * nothing has been written, the row stays unmatched, and the next round picks
 * it up again.
 */
export function parsePostingMatch(text: string): PostingMatch {
  return parseJsonAgainstSchema(PostingMatchSchema, text, {
    producer: "match assessor",
    schemaName: "posting-match",
  })
}
