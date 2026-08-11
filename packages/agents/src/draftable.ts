/**
 * Whether a candidate background can honestly back a CV-backed write.
 *
 * Shared by every feature that writes *from* the candidate's own document —
 * cover letters, tailored resumes, match assessment, criteria suggestion —
 * rather than owned by any one of them. A Posting Document is the glossary
 * name for the first two; the guard itself is about draftability of the
 * profile, not about letters.
 *
 * The definitions live in `candidate-profile.ts`, alongside the schema for the
 * document itself — `main` grew that module independently of this one, for the
 * same "shared by every CV-backed write" reason, and the two collapsed onto it
 * rather than onto a second copy. This module re-exports the three symbols so
 * `@workspace/agents/draftable` keeps meaning what it says: the shape a
 * feature that only cares about draftability, not about the profile schema,
 * should import.
 */
export {
  assertDraftable,
  MAX_BACKGROUND_CHARS,
  MIN_BACKGROUND_CHARS,
  UndraftableError,
  type UndraftableReason,
} from "./candidate-profile.ts"
