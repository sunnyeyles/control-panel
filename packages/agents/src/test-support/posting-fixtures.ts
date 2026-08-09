/**
 * One Posting fixture for every suite that assembles a posting-document
 * request. Shaped like what a SEEK search actually returns: a teaser-level
 * record, with `highlights` copied off the advertisement and
 * `summary`/`matchReason` composed by the scout. The two features consume the
 * identical record, so a Posting one suite accepts the other must too — which
 * is why this is one fixture rather than a copy per suite.
 */
const CORE = {
  title: "Senior Backend Engineer",
  company: "Morgan McKinley",
  location: "Sydney NSW (Hybrid)",
  url: "https://www.seek.com.au/job/93431609",
  summary: "A backend role on a real-time data product.",
  matchReason: "Backend, Sydney, and the stack the candidate asked for.",
}

/** Copied off the advertisement, which is what makes them safe to reproduce. */
export const HIGHLIGHTS = [
  "Senior Backend Engineer (Python/AWS) - real-time data product, global clients",
  "Own async pipelines & AWS infra - queues, workers, full ownership",
]

export const POSTING = {
  ...CORE,
  postedAt: "2026-07-21",
  highlights: HIGHLIGHTS,
}

/** Both optional fields are genuinely absent often, so both get a variant. */
export const WITHOUT_HIGHLIGHTS = { ...CORE, postedAt: "2026-07-21" }
export const UNDATED = { ...CORE, highlights: HIGHLIGHTS }
