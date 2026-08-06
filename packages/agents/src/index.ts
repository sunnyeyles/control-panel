export { createAssistant, type CreateAssistantOptions } from "./assistant.ts"

export {
  createBriefWriter,
  type CreateBriefWriterOptions,
} from "./brief-writer.ts"

export {
  assertDraftable,
  CoverLetterRequestSchema,
  MAX_EXAMPLE_LETTER_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  toCoverLetterPrompt,
  UndraftableError,
  type CoverLetterRequest,
  type LetterInstructions,
} from "./cover-letter.ts"

export {
  COVER_LETTER_WRITER_SYSTEM_PROMPT,
  coverLetterSystemPrompt,
  createCoverLetterWriter,
  type CreateCoverLetterWriterOptions,
} from "./cover-letter-writer.ts"

export { parseSearchCriteria } from "./criteria.ts"

export {
  FindingsSchema,
  parseFindings,
  PostingSchema,
  type Findings,
  type Posting,
} from "./findings.ts"

export { postingId } from "./posting-id.ts"

export {
  createProfileExtractor,
  toProfilePrompt,
  type CreateProfileExtractorOptions,
} from "./profile-extractor.ts"

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
  JOB_SCOUT_SEARCH_TOOLS,
  type CreateJobScoutOptions,
} from "./job-scout.ts"

export type { Agent } from "@workspace/agents-core"
