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
  FindingsSchema,
  jobScoutSchemaDescription,
  parseFindings,
  PostingSchema,
  type Findings,
  type Posting,
} from "./findings.ts"

export {
  createJobScout,
  JOB_SCOUT_MAX_LLM_CALLS,
  JOB_SCOUT_SYSTEM_PROMPT,
  type CreateJobScoutOptions,
} from "./job-scout.ts"

export type { Agent } from "@workspace/agents-core"
