export {
  DEFAULT_MAX_POSTINGS,
  JobSearchConfigSchema,
  MAX_POSTINGS_PER_BRIEF,
  parseJobSearchConfig,
  scoutLlmCallBudget,
  toSearchBrief,
  type JobSearchConfig,
  type SearchPass,
} from "./job-search-config.ts"

export {
  formatTitleExclusions,
  isExcludedTitle,
  MAX_TITLE_EXCLUSIONS,
  normalizeTitle,
  parseTitleExclusions,
  partitionByExcludedTitle,
  titleMatchPattern,
} from "./title-exclusions.ts"
