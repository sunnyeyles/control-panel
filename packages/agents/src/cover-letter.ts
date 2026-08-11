import * as z from "zod"

import { toPostingRequestPrompt } from "./posting-prompt.ts"
import { StoredPostingSchema } from "./stored-posting.ts"

/**
 * The contract for one cover letter.
 *
 * It lives here rather than inside the writer, and for the same reason
 * `findings.ts` does: it belongs to neither side. The caller assembles a
 * request — a Posting it already holds and a document the candidate already
 * wrote — and this module is what says whether that request is answerable and
 * what the model is asked. The writer itself is a prompt and an empty tool set.
 *
 * Everything here is pure. Nothing reads the environment, nothing reaches the
 * network, and {@link toCoverLetterPrompt} is a string function — so the
 * decisions that matter (what is refused, what is carried through verbatim)
 * are testable without a provider key.
 *
 * Draftability of the background (`assertDraftable`, the bounds, and
 * `UndraftableError`) lives in `draftable.ts` — shared with every CV-backed
 * write, not owned by letters. Re-exported here so existing
 * `@workspace/agents/cover-letter` imports keep working.
 */

export {
  assertDraftable,
  MAX_BACKGROUND_CHARS,
  MIN_BACKGROUND_CHARS,
  UndraftableError,
  type UndraftableReason,
} from "./draftable.ts"

/**
 * How much the candidate may write about *how* to write their letters.
 *
 * Two thousand characters is a page of rules — far more than "never use the
 * word 'passionate', sign off Kind regards" needs, and short of the length at
 * which a rule list stops being a rule list and starts being a second prompt
 * competing with the writer's own. Over it, refuse: the same argument as
 * {@link MAX_BACKGROUND_CHARS}, and sharper here, because a truncated rule list
 * silently drops whichever rules the user typed last while every letter still
 * comes back looking obedient.
 */
export const MAX_INSTRUCTIONS_CHARS = 2_000

/**
 * The example letter gets a larger cap than the instructions, deliberately.
 *
 * A letter is prose and a rule list is not: 6,000 characters is a long cover
 * letter with room for a covering note around it, where the same allowance
 * spent on rules would be pathological. Over it, refuse rather than truncate —
 * half an example letter is a style reference with its ending cut off, and the
 * model has no way to know the register it is imitating was never finished.
 */
export const MAX_EXAMPLE_LETTER_CHARS = 6_000

/**
 * What the candidate saved about how their letters should read.
 *
 * Both fields are optional and empty is the ordinary state for each — a user
 * who never opens Settings composes to the writer's prompt untouched.
 *
 * They are two fields rather than one blob because they are fenced differently,
 * and that fencing is a correctness property rather than presentation. An
 * example letter is full of claims about somebody; in one undifferentiated blob
 * the model cannot tell a style reference from a source of facts, and lifts
 * those claims into a letter sent in the candidate's name.
 *
 * **The bounds above are not enforced here or anywhere in this package.** They
 * are enforced at save time in the dashboard, loudly, with a message naming the
 * count and the limit — so the person who can fix it is told what to fix.
 * `coverLetterSystemPrompt` never truncates: a prompt quietly built from the
 * first half of an example letter is indistinguishable from one built from all
 * of it, which is the exact silent failure the caps exist to prevent.
 */
export interface LetterInstructions {
  instructions?: string
  exampleLetter?: string
}

export const CandidateProfileSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "The candidate's name, if the caller knows it. Absent is fine — the letter then leaves a placeholder rather than inventing one."
    ),
  background: z
    .string()
    .describe(
      "The candidate's own words about themselves, verbatim. This is the only source for anything the letter claims about the candidate."
    ),
})

export const CoverLetterRequestSchema = z.object({
  // The *stored* shape, not `PostingSchema`: a Posting the user added by
  // pasting its link carries no `matchReason`, and refusing to draft a letter
  // for one would be refusing over a field the letter does not need.
  posting: StoredPostingSchema,
  profile: CandidateProfileSchema,
})

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>
export type CoverLetterRequest = z.infer<typeof CoverLetterRequestSchema>

/**
 * The prompt, built from the request and nothing else.
 *
 * The body — the posting block, the quoted-material fence, the verbatim
 * carry-through — lives in `posting-prompt.ts` and holds its properties for
 * every feature built on it. What belongs to *this* feature is the wording:
 * the letter is written *from* the background, so the document is introduced
 * as the source every claim must be traceable to.
 */
export function toCoverLetterPrompt(request: CoverLetterRequest): string {
  return toPostingRequestPrompt(request, {
    opening: "Write my cover letter for the posting below.",
    backgroundHeading: "## My background",
    backgroundIntro:
      "This is my own document, reproduced exactly. Every claim the letter makes about me must be traceable to it:",
  })
}
