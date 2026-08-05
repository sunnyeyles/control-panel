# 05 — Make Scout retrieval measurable and relevance-ranked

**What to build:** turn a **Briefing**'s search from “give a model some live listings and
ask it to choose” into a retrieval pipeline whose coverage and decisions can be inspected.

Today the model decides which title/location combinations to query, what terms to send, when
to stop, and which of up to 20 newest listings per search become **Findings**. The Scout’s
prompt says to make one focused search per title and location, but it does not make that
instruction executable. `maxPostings` is a prose “at most” cap, not a retrieval target.
Three boards would multiply the candidate context and preserve the same opaque selection
step. This ticket fixes the retrieval shape before treating more sources as better search.

The worker owns the first half:

1. Expand the Job’s titles and locations into an explicit, bounded set of search requests.
   Each has a board, title, location, optional keywords and freshness bound. The bound is
   visible in the plan and in the run report; a Job with more combinations than the budget
   must fail or say which requests it did not run, never silently skip arbitrary criteria.
2. Invoke every board adapter for those requests and retain a typed candidate record, rather
   than only the formatted string currently handed to the model. A candidate carries its
   canonical URL, source, title, company, location, listing date and bounded quoted
   description.
3. Deduplicate candidates by their normalised URL before ranking. Cross-board grouping stays
   ticket 02’s separate, conservative concern; this step only removes the same URL returned
   twice by one or several searches.
4. Apply deterministic cheap filters that the configuration can state exactly: recency,
   title/location request provenance and explicit exclusions. Do not pretend a substring
   filter understands seniority or a role’s semantics.

The Scout owns only the second half: rank and explain a **bounded** candidate set. It no
longer chooses whether a configured criterion was searched. Its structured answer may select
only candidate URLs the worker supplied, then adds the existing `summary`, `matchReason` and
verbatim `highlights`. Preserve the current URL-evidence check at this new boundary.

The pipeline must retain enough observability to answer “why did this brief contain three
postings?” without a paid replay: planned requests, completed requests, raw candidate count,
same-URL duplicates removed, deterministic-filter removals, candidates given to the Scout and
final Findings count. The one-line Run Report carries counts; the development trace renders
the requests and candidates; no production log should carry a full advertisement description.

**Blocked by:** 03 — Search LinkedIn alongside the others. The typed candidate vocabulary
belongs around every board adapter, not as a SEEK-only side path. It does **not** depend on
04: selecting sources changes which requests are planned, not how a planned request is
retrieved or ranked.

**Status:** ready-for-agent

- [ ] A Job’s configured title/location pairs become inspectable, bounded requests; none are
      left to a model deciding whether to search them
- [ ] Board adapters produce one shared typed candidate shape as well as their model-facing
      formatting, so the worker can pool candidates without reparsing prose
- [ ] Repeated canonical URLs never reach ranking twice; ticket 02 remains the only place
      that may group different URLs across boards
- [ ] A candidate set is bounded before it reaches the model, with the policy and its
      per-source allocation stated in code and covered by tests
- [ ] The Scout can select only a candidate URL the worker supplied; a model-invented or
      altered URL fails before a Brief is written
- [ ] The run report and local trace distinguish planned searches, successful searches,
      candidates retrieved, candidates filtered and postings selected
- [ ] Tests cover a multi-title/multi-location Job, a request-budget overflow, duplicate
      URLs, an explicit exclusion and an invalid selected URL
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**Do not solve this by raising `JOB_SCOUT_MAX_LLM_CALLS` or `maxItems`.** Those only give the
model more discretion and more context. The target is better coverage and an explainable
candidate set, not more unaccounted-for listings.
