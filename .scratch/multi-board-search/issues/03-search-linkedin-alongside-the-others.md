# 03 — Search LinkedIn alongside the others

**What to build:** the third board. A `linkedin_search` tool over Apify's
`curious_coder/linkedin-jobs-scraper`, registered in
`packages/agents/src/job-scout.ts` with the other board descriptors.

**The actor takes a search URL, not parameters.** It wants a linkedin.com/jobs search URL with
the filters already applied, so this tool has to build one: keywords and location into the
query string, `daysOld` into LinkedIn's seconds-based recency filter, `workType` into its
employment-type codes. That translation lives inside the tool and is unit-testable on its own.
**The tool's input schema stays the same five fields the other two present** — the scout does
not learn that one board is different. LinkedIn also caps a single search URL at 1,000 results;
record that limit beside the URL builder.

**The terms position must be decided before implementation and recorded in the tool's
docblock.** It must state that the actor runs without cookies or a personal LinkedIn account;
the decision cannot be inherited silently from another board.

**Measure a real three-board run for context and cost.** If context is tight, reduce results per
board; do not treat a higher model-call ceiling as a context fix.

**Blocked by:** 02 — Collapse a posting found on two boards. Landing LinkedIn before grouping
exists would put a third copy of the same advertisement in every brief.

**Status:** ready-for-agent

- [ ] `linkedin_search` returns currently-open LinkedIn postings, each with a canonical
      LinkedIn URL, its listing date and the advertisement's own description
- [ ] Its input schema matches the other two boards'; the URL building is internal and tested
      directly, including the recency and employment-type translations
- [ ] Failure posture matches SEEK's and Indeed's — a rejected token throws, everything else
      returns a sentence the scout can act on
- [ ] The docblock states the terms position explicitly, as `seek-search.ts` does for SEEK,
      including that no personal LinkedIn account authenticates the requests
- [ ] LinkedIn provenance parameters are dropped by `normalisePostingUrl`, verified against
      URLs the actor actually returned
- [ ] Existing cross-board grouping collapses an advertisement listed on all three boards into
      one Posting with two entries in `alsoOn`
- [ ] `JOB_SCOUT_MAX_LLM_CALLS` is raised again and its comment still shows the arithmetic
- [ ] A real three-board run is measured for context and cost, and the numbers are written into
      the pull request rather than estimated
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
