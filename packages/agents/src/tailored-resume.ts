import type * as z from "zod"

import { CoverLetterRequestSchema } from "./cover-letter.ts"
import { toPostingRequestPrompt } from "./posting-prompt.ts"

/**
 * The contract for one tailored resume.
 *
 * The same arrangement as `cover-letter.ts`, for the same reason: the caller
 * assembles a request out of a Posting it already holds and a document the
 * candidate already wrote, and this module says what the model is asked. The
 * agent itself is a prompt and an empty tool set.
 *
 * ⚠️ **The bounds live in `candidate-profile.ts` and are reused, not restated.**
 * `assertDraftable` and `UndraftableError` are already structural — the guard
 * takes `{ background }` rather than a `CandidateProfile` — and
 * `suggest-criteria-actions.ts` in the dashboard is the standing precedent for a
 * feature that is not a letter reusing them. A second copy of
 * `MIN_BACKGROUND_CHARS` would be a second number to keep in step with the first,
 * and the question it answers is the same one: is there enough of this person's
 * own document to work from, or would the output be invented?
 *
 * Everything here is pure. Nothing reads the environment and nothing reaches the
 * network, so what is refused and what is carried through verbatim are testable
 * without a provider key.
 */

/**
 * The identical request shape, under this feature's name. One schema object,
 * not a restatement — a Posting the letter accepts, the rewrite must too.
 */
export const TailoredResumeRequestSchema = CoverLetterRequestSchema

export type TailoredResumeRequest = z.infer<typeof TailoredResumeRequestSchema>

/**
 * The prompt, built from the request and nothing else.
 *
 * The body lives in `posting-prompt.ts` and holds the verbatim and fencing
 * properties for both features. What belongs to *this* one is the whole
 * difference between them: the CV is introduced as **the document being
 * rewritten**, not as a source to write *about*. The letter's prompt says
 * "every claim the letter makes about me must be traceable to it"; this one
 * says the output is that document, reordered and re-emphasised, and that a
 * line with no counterpart in it is an invention.
 */
export function toTailoredResumePrompt(request: TailoredResumeRequest): string {
  return toPostingRequestPrompt(request, {
    opening: "Rewrite my resume for the posting below.",
    backgroundHeading: "## My resume",
    backgroundIntro:
      "This is my own resume, reproduced exactly. It is the document you are rewriting and the only source for anything in your answer. Every line you return must have a counterpart here:",
  })
}
