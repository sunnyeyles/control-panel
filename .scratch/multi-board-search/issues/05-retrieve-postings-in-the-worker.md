# 05 — Retrieve postings in the worker, not in the Scout

**What to build:** the worker decides what to retrieve and retrieves it; the **Scout**
ranks what it is handed and explains its choices. Today one model-call chain decides which
title/location pairs to search, what terms to use, when it has searched enough, and which
returned postings make a **Brief**. The prompt asks for one focused search per title and
location, but an instruction is not a query plan, and nothing records which configured
criteria were actually looked up. A thin brief is indistinguishable from a criterion the
model quietly skipped.

**This is the largest ticket here and it is deliberately off the critical path.** An
earlier revision sequenced it second, on the grounds that a board is a tool the model
calls before it and an adapter the worker calls after, so boards would be built twice.
01 and 02 remove that argument by exporting a typed function with the `tool()` wrapper on
top — the shape `seek-search.ts` already has. This ticket then changes who calls the
function and deletes the wrapper. Land it when it is worth landing, not to unblock a board.

## The worker's half

1. **Expand the Job's titles and locations into an explicit, bounded request set.** Each
   request names a board, a title, a location, optional keywords and a freshness bound,
   and the bound is reported. A Job with more combinations than the budget must fail or
   say which requests it did not run — never silently drop criteria, which is the failure
   this ticket exists to remove.
2. **Invoke every board function for those requests and keep the typed record**, not only
   the formatted string the model sees today. A **retrieved Posting** carries its
   canonical URL, board, title, company, location, listing date and bounded description.
3. **Deduplicate by normalised URL before ranking** — the _same_ URL returned twice, and
   nothing more. Collapsing different URLs across boards is 03's job and is conservative
   in ways this step is not.
4. **Apply only the deterministic filters configuration can state exactly** — recency, the
   request a posting came from, explicit exclusions. Do not pretend a substring filter
   understands seniority.
5. **Bound the pool before it reaches the model**, with a stated per-board allocation.
   Measured, Indeed returns 77 KB for six results and a three-title two-location
   three-board Job is eighteen requests — order of 1.4 MB and 350k tokens. At that size a
   run does not get slower, it fails.

## The Scout's half

Rank and explain a bounded pool. Its structured answer may select **only** URLs the
worker supplied, and it adds the existing `summary`, `matchReason` and verbatim
`highlights`. It no longer decides whether a configured criterion was searched.

This does not turn relevance into a keyword test. Seniority, transferable skills and
whether a description genuinely suits stay with the model. The code owns coverage,
provenance, bounded context and URL identity — the things it can prove.

## What moves, and must not be lost on the way

**The evidence gate.** `run-briefing.ts` rejects any reported URL that did not appear
verbatim in a search result. Preserve the property at the new boundary: a selected URL
must be one the worker retrieved. It gets stricter here — set membership rather than
substring containment.

**The search gate.** `run-briefing.ts` fails a run whose Scout completed no successful
search on any tool in `SEARCH_TOOL_NAMES`. There are no search tool messages left to
count, so move the gate onto the worker's own request bookkeeping and delete or repurpose
`successfulSearchResults` rather than leaving a module that looks authoritative and counts
nothing.

**The model-call budget.** 01 made `JOB_SCOUT_MAX_LLM_CALLS` a per-run computation over
`titles × locations × boards`. That coupling ends here: a Scout that does not search needs
a small fixed ranking budget. Remove the computation rather than leaving it
correct-by-accident.

**`run-briefing.ts`'s docblock.** It predicts that the fan-out "replaces what produces
`findings` and leaves everything downstream alone" — true of the board tickets, false
here, because this moves work _upstream_ of the Scout. It is the file's orienting comment;
rewrite it.

**Blocked by:** 01 — Search Indeed alongside SEEK. One board cannot show whether the
pooling is board-neutral.

**Status:** ready-for-agent

- [ ] A Job's configured title/location pairs become inspectable, bounded requests; none
      are left to a model deciding whether to search them
- [ ] A Job exceeding the request budget fails, or reports exactly which requests it did
      not run — verified by a test, not by reading the code
- [ ] Board functions produce one shared typed retrieved-Posting shape, so the worker
      pools without reparsing prose
- [ ] Repeated canonical URLs never reach ranking twice; different URLs across boards are
      left alone for 03
- [ ] The pool is bounded before the model, with the policy and per-board allocation
      stated in code and covered by tests
- [ ] The Scout can select only a URL the worker retrieved; an invented or altered URL
      fails before a Brief is written
- [ ] The no-retrieval gate runs on the worker's request bookkeeping, and
      `successfulSearchResults`/`SEARCH_TOOL_NAMES` are removed or repurposed rather than
      left counting nothing
- [ ] The Scout's ceiling is a small fixed ranking budget again; 01's per-run computation
      is gone
- [ ] `run-briefing.ts`'s pipeline docblock describes the pipeline the file now runs
- [ ] No prose or identifier here calls a retrieved Posting a "candidate"
- [ ] Tests cover a multi-title/multi-location Job, a budget overflow, duplicate URLs, an
      explicit exclusion and an invalid selected URL
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
