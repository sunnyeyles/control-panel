export {
  defineToollessAgent,
  type ExtraToolsAgentOptions,
  type ToollessAgentOptions,
} from "./agent-options.ts"

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

export {
  BOARDS_FETCHED_BY_URL,
  fetchPostingByUrl,
  type PostingFetch,
  type PostingFetchDeps,
} from "./board-fetch.ts"

export { parseSearchCriteria } from "./criteria.ts"

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
  createPostingExtractor,
  parsePostingExtraction,
  POSTING_EXTRACTOR_SYSTEM_PROMPT,
  PostingExtractionSchema,
  toPostingExtractionPrompt,
  type CreatePostingExtractorOptions,
  type ExtractedPosting,
  type PostingExtraction,
} from "./posting-extractor.ts"

export { StoredPostingSchema, type StoredPosting } from "./stored-posting.ts"

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
  JOB_SCOUT_SEARCH_TOOL_NAMES,
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
