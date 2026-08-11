import * as z from "zod"

/**
 * The candidate's own document, and the bounds that say whether anything can
 * honestly be written from it.
 *
 * It lives here rather than inside any one feature because the same question —
 * is there enough of this person's words to work from, or would the output be
 * invented? — is asked by the cover letter, the tailored resume, the match
 * score and the criteria suggestion. One schema, one refusal, one pair of
 * caps; a second copy of any of them would be a second number to keep in step.
 *
 * Everything here is pure. Nothing reads the environment and nothing reaches
 * the network, so what is refused is testable without a provider key.
 */

/**
 * Below this many characters of background, there is nothing to write *from*.
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

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>

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
