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
 */

/**
 * Below this many characters of background, there is nothing to write a letter
 * *from*.
 *
 * A letter drafted with no candidate substance is not a thin letter, it is a
 * fabricated one: every specific it contains would have been invented and then
 * attributed to the user. Two hundred characters is roughly two sentences —
 * low enough to accept a deliberately terse profile, high enough to catch an
 * empty file, a failed extraction, or a document that turned out to be a
 * heading and a phone number.
 */
export const MIN_BACKGROUND_CHARS = 200

/**
 * Above this, refuse rather than truncate.
 *
 * Truncating is the same silent failure wearing different clothes: a letter
 * written from the first half of a CV, with nothing anywhere saying so, reads
 * exactly like a letter written from all of it. Refusing is loud, and the fix
 * (point it at the right document) belongs to the person who owns the
 * document.
 */
export const MAX_BACKGROUND_CHARS = 20_000

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

/** Why a request cannot be answered. Each is a distinct thing to tell a user. */
export type UndraftableReason = "absent" | "too-short" | "too-long"

/**
 * The refusal, as a type rather than a message.
 *
 * A caller has to distinguish "you have not uploaded anything readable" from
 * "that document is too large" to say anything useful about either, and
 * matching on a message string is how that distinction rots.
 */
export class UndraftableError extends Error {
  readonly reason: UndraftableReason
  /** How much background there actually was, after trimming. */
  readonly length: number

  constructor(reason: UndraftableReason, length: number, message: string) {
    super(message)
    this.name = "UndraftableError"
    this.reason = reason
    this.length = length
  }
}

/**
 * Refuse a request that cannot honestly be answered — **before** the model is
 * called.
 *
 * This is the transplant of the rule that makes a run with no successful
 * search fail. That rule guards against silent fabrication rather than against
 * absence: a brief citing postings nobody looked up looks perfect and is
 * worthless, while a missing brief is loud. The same reasoning applies here
 * with more force, because a cover letter asserts things about a person to a
 * stranger.
 *
 * Deliberately about the background alone. A Posting is thin often and
 * legitimately — a teaser is what a search returns — and a thin Posting yields
 * a vaguer letter, not a false one.
 */
export function assertDraftable(profile: {
  background?: string | null | undefined
}): void {
  const background = profile.background?.trim() ?? ""

  if (background.length === 0) {
    throw new UndraftableError(
      "absent",
      0,
      "There is no candidate background to write from. A letter drafted from nothing would invent every specific in it and attribute the result to the candidate."
    )
  }

  if (background.length < MIN_BACKGROUND_CHARS) {
    throw new UndraftableError(
      "too-short",
      background.length,
      `The candidate background is ${background.length} characters, under the ${MIN_BACKGROUND_CHARS} needed to write a letter from it rather than around it.`
    )
  }

  if (background.length > MAX_BACKGROUND_CHARS) {
    throw new UndraftableError(
      "too-long",
      background.length,
      `The candidate background is ${background.length} characters, over the ${MAX_BACKGROUND_CHARS} limit. Refused rather than truncated: a letter written from part of a document, with nothing saying so, is indistinguishable from one written from all of it.`
    )
  }
}

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
