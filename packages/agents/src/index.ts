export { createAssistant, type CreateAssistantOptions } from "./assistant.ts"

export {
  BRIEF_WRITER_SYSTEM_PROMPT,
  createBriefWriter,
  type CreateBriefWriterOptions,
} from "./brief-writer.ts"

export {
  assertDraftable,
  CandidateProfileSchema,
  CoverLetterRequestSchema,
  MAX_BACKGROUND_CHARS,
  MAX_EXAMPLE_LETTER_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MIN_BACKGROUND_CHARS,
  toCoverLetterPrompt,
  UndraftableError,
  type CandidateProfile,
  type CoverLetterRequest,
  type LetterInstructions,
  type UndraftableReason,
} from "./cover-letter.ts"

export {
  COVER_LETTER_WRITER_SYSTEM_PROMPT,
  coverLetterSystemPrompt,
  createCoverLetterWriter,
  type CreateCoverLetterWriterOptions,
} from "./cover-letter-writer.ts"

export {
  criteriaSchemaDescription,
  parseSearchCriteria,
  SearchCriteriaSchema,
  type SearchCriteria,
} from "./criteria.ts"

export {
  FindingsSchema,
  jobScoutSchemaDescription,
  parseFindings,
  PostingSchema,
  type Findings,
  type Posting,
} from "./findings.ts"

export { boardForHost, JOB_BOARDS, type JobBoard } from "./job-boards.ts"

export { postingId } from "./posting-id.ts"

export {
  createProfileExtractor,
  PROFILE_EXTRACTOR_SYSTEM_PROMPT,
  toProfilePrompt,
  type CreateProfileExtractorOptions,
} from "./profile-extractor.ts"

export {
  createJobScout,
  JOB_SCOUT_MAX_LLM_CALLS,
  JOB_SCOUT_SEARCH_TOOLS,
  JOB_SCOUT_SYSTEM_PROMPT,
  type CreateJobScoutOptions,
} from "./job-scout.ts"

export type { Agent } from "@workspace/agents-core"
