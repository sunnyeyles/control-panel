# 05 — Make Scout retrieval measurable and relevance-ranked

**What to build:** an inspectable retrieval pipeline followed by relevance ranking. The worker,
not the Scout, decides which configured criteria to retrieve; the Scout ranks a bounded
candidate set and explains its selections.

The worker owns the first half:

1. Expand the Job’s titles and locations into an explicit, bounded set of search requests.
   Each has a board, title, location, optional keywords and freshness bound. The bound is
   reported by the run; a Job with more combinations than the budget must fail or say which
   requests it did not run, never silently skip arbitrary criteria.
2. Invoke every board adapter for those requests and retain a typed candidate record, rather
   than only the formatted string currently handed to the model. A candidate carries its
   canonical URL, source, title, company, location, listing date and bounded quoted
   description.
3. Deduplicate candidates by their normalised URL before ranking. Cross-board grouping is a
   separate, conservative concern; this step only removes the same URL returned twice by one
   or several searches.
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
04: source selection changes which requests are planned, not how a planned request is retrieved
or ranked.

**Status:** ready-for-agent

- [ ] A Job’s configured title/location pairs become inspectable, bounded requests; none are
      left to a model deciding whether to search them
- [ ] Board adapters produce one shared typed candidate shape as well as their model-facing
      formatting, so the worker can pool candidates without reparsing prose
- [ ] Repeated canonical URLs never reach ranking twice; this ticket does not group different
      URLs across boards
- [ ] A candidate set is bounded before it reaches the model, with the policy and its
      per-source allocation stated in code and covered by tests
- [ ] The Scout can select only a candidate URL the worker supplied; a model-invented or
      altered URL fails before a Brief is written
- [ ] The run report and local trace distinguish planned searches, successful searches,
      candidates retrieved, candidates filtered and postings selected
- [ ] Tests cover a multi-title/multi-location Job, a request-budget overflow, duplicate
      URLs, an explicit exclusion and an invalid selected URL
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
