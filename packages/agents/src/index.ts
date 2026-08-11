export {
  defineToollessAgent,
  type ExtraToolsAgentOptions,
  type ToollessAgentOptions,
} from "./agent-options.ts"

export {
  ASSISTANT_SYSTEM_PROMPT,
  createAssistant,
  type CreateAssistantOptions,
} from "./assistant.ts"

export {
  BRIEF_WRITER_SYSTEM_PROMPT,
  createBriefWriter,
  type CreateBriefWriterOptions,
} from "./brief-writer.ts"

export {
  assertDraftable,
  CandidateProfileSchema,
  MAX_BACKGROUND_CHARS,
  MIN_BACKGROUND_CHARS,
  UndraftableError,
  type CandidateProfile,
} from "./candidate-profile.ts"

export {
  CoverLetterRequestSchema,
  MAX_EXAMPLE_LETTER_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  toCoverLetterPrompt,
  type CoverLetterRequest,
  type LetterInstructions,
} from "./cover-letter.ts"

export {
  COVER_LETTER_WRITER_SYSTEM_PROMPT,
  coverLetterSystemPrompt,
  createCoverLetterWriter,
  type CreateCoverLetterWriterOptions,
} from "./cover-letter-writer.ts"

export {
  BOARDS_FETCHED_BY_URL,
  fetchPostingByUrl,
  type PostingFetch,
  type PostingFetchDeps,
} from "./board-fetch.ts"

export { parseSearchCriteria, toSearchCriteriaPrompt } from "./criteria.ts"

export { findExperienceStatement } from "./experience.ts"

export {
  MatchRequestSchema,
  MAX_MATCH_SCORE,
  MIN_MATCH_SCORE,
  parsePostingMatch,
  PostingMatchSchema,
  toMatchPrompt,
  type MatchRequest,
  type PostingMatch,
} from "./match.ts"

export {
  createMatchAssessor,
  MATCH_ASSESSOR_SYSTEM_PROMPT,
  type CreateMatchAssessorOptions,
} from "./match-assessor.ts"

export {
  FindingsSchema,
  parseFindings,
  PostingSchema,
  type Findings,
  type Posting,
  type ScoutFindings,
  type ScoutPosting,
} from "./findings.ts"

export { parsePostedAt } from "./posted-at.ts"

export { postingId } from "./posting-id.ts"

export {
  parsePostingExtraction,
  postingExtractionSchemaDescription,
  PostingExtractionSchema,
  toPostingExtractionPrompt,
  type ExtractedPosting,
  type PostingExtraction,
} from "./posting-extraction.ts"

export {
  createPostingExtractor,
  POSTING_EXTRACTOR_SYSTEM_PROMPT,
  type CreatePostingExtractorOptions,
} from "./posting-extractor.ts"

export { StoredPostingSchema, type StoredPosting } from "./stored-posting.ts"

export {
  createProfileExtractor,
  PROFILE_EXTRACTOR_SYSTEM_PROMPT,
  type CreateProfileExtractorOptions,
} from "./profile-extractor.ts"

export {
  parseRoleTitleSuggestions,
  RoleTitleSuggestionsSchema,
  type RoleTitleSuggestions,
} from "./role-titles.ts"

export {
  createRoleTitleSuggester,
  ROLE_TITLE_SUGGESTER_SYSTEM_PROMPT,
  toRoleTitleSuggestionsPrompt,
  type CreateRoleTitleSuggesterOptions,
} from "./role-title-suggester.ts"

export {
  createResumeTailor,
  RESUME_TAILOR_SYSTEM_PROMPT,
  type CreateResumeTailorOptions,
} from "./resume-tailor.ts"

export {
  TailoredResumeRequestSchema,
  toTailoredResumePrompt,
  type TailoredResumeRequest,
} from "./tailored-resume.ts"

export {
  createJobScout,
  JOB_SCOUT_MAX_LLM_CALLS,
  JOB_SCOUT_SEARCH_TOOL_NAMES,
  JOB_SCOUT_SYSTEM_PROMPT,
  type CreateJobScoutOptions,
  type JobScoutSession,
} from "./job-scout.ts"

export {
  createWhiteboardAgent,
  WHITEBOARD_MAX_LLM_CALLS,
  WHITEBOARD_SYSTEM_PROMPT,
  type CreateWhiteboardAgentOptions,
  type WhiteboardSession,
} from "./whiteboard.ts"

export type { Agent } from "@workspace/agents-core"

/**
 * Re-exported so a caller of {@link JobScoutSession.searches} can name what it
 * gets back without importing `@workspace/agent-tools` for a type — the same
 * courtesy `Agent` gets above.
 */
export type { SearchAttempt } from "@workspace/agent-tools/search-log"
