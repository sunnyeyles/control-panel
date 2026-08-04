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
  MIN_BACKGROUND_CHARS,
  toCoverLetterPrompt,
  UndraftableError,
  type CandidateProfile,
  type CoverLetterRequest,
  type UndraftableReason,
} from "./cover-letter.ts"

export {
  COVER_LETTER_WRITER_SYSTEM_PROMPT,
  createCoverLetterWriter,
  type CreateCoverLetterWriterOptions,
} from "./cover-letter-writer.ts"

export {
  FindingsSchema,
  jobScoutSchemaDescription,
  parseFindings,
  PostingSchema,
  type Findings,
  type Posting,
} from "./findings.ts"

export { postingId } from "./posting-id.ts"

export {
  createJobScout,
  JOB_SCOUT_MAX_LLM_CALLS,
  JOB_SCOUT_SEARCH_TOOLS,
  JOB_SCOUT_SYSTEM_PROMPT,
  type CreateJobScoutOptions,
} from "./job-scout.ts"

export type { Agent } from "@workspace/agents-core"
