/**
 * User-facing "not found" copy shared across action modules that refuse the
 * same way for "absent" and "someone else's" — distinct messages would turn a
 * form that takes an id into an oracle for whether another user's row exists.
 */

/** Posting actions and cover-letter actions. */
export const POSTING_NOT_FOUND = "That posting could not be found."

/** Job (briefing) actions and run-now actions. */
export const BRIEFING_NOT_FOUND = "That briefing could not be found."
