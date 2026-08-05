# 05 — Retrieve postings in the worker, not in the Scout

**What to build:** the worker decides what to retrieve and retrieves it; the **Scout** ranks
what it is handed and explains its choices. Today one model-call chain decides which
title/location pairs to search, what terms to use, when it has searched enough, and which
returned postings make a **Brief**. The prompt asks for one focused search per title and
location, but an instruction is not a query plan, and nothing records which configured criteria
were actually looked up. A thin brief is currently indistinguishable from a criterion the model
quietly skipped.

**This ticket lands second, immediately after 01, and that placement is deliberate.** It
changes what a board integration _is_: before it, a board is a tool the model calls; after it,
a board is an adapter the worker calls. Sequenced after 03 — where an earlier draft of this
plan put it — 01 and 03 would each build a board twice, 01 would build a per-board count
against a mechanism due for retirement, and 04 would wire a filter onto a tool list that stops
being where boards live. Landing it at two boards costs one conversion instead of two.

## The worker's half

1. **Expand the Job's titles and locations into an explicit, bounded request set.** Each request
   names a board, a title, a location, optional keywords and a freshness bound. The bound is
   reported. A Job with more combinations than the budget must fail, or say which requests it
   did not run — never silently drop criteria, which is the failure this whole ticket exists to
   remove.
2. **Invoke every board adapter for those requests and keep a typed record**, not only the
   formatted string handed to the model today. A **retrieved Posting** carries its canonical
   URL, board, title, company, location, listing date and bounded quoted description.
3. **Deduplicate by normalised URL before ranking.** This removes the _same_ URL returned twice
   by one or several requests, and nothing more. Collapsing different URLs across boards is
   02's job and is deliberately conservative in ways this step is not.
4. **Apply only the deterministic filters configuration can state exactly** — recency, the
   title/location request a posting came from, explicit exclusions. Do not pretend a substring
   filter understands seniority.
5. **Bound the pool before it reaches the model**, with a stated per-board allocation. This is
   part of this ticket rather than deferred to 06, because the arithmetic is not marginal:
   twenty results with descriptions measured ~79 KB **per request**, and a three-title,
   two-location, three-board Job is eighteen requests — order of 1.4 MB and 350k tokens. At that
   size the run does not get slower, it fails.

## The Scout's half

Rank and explain a bounded pool. It no longer chooses whether a configured criterion was
searched. Its structured answer may select **only** URLs the worker supplied, and it adds the
existing `summary`, `matchReason` and verbatim `highlights`.

This does not turn relevance into a keyword test. Seniority, transferable skills and whether a
description genuinely suits remain judgement calls and stay with the model. The code owns
coverage, provenance, bounded context and URL identity — the things it can prove.

## What moves, and must not be lost on the way

**The evidence gate.** `run-briefing.ts` today rejects any reported URL that did not appear
verbatim in a search result. Preserve the property at the new boundary: a selected URL must be
one the worker retrieved. It gets stricter here, not weaker — set membership rather than
substring containment.

**The search gate.** `run-briefing.ts` fails a run whose Scout completed no successful search on
any tool in `SEARCH_TOOL_NAMES`. After this ticket there are no search tool messages to count,
so `successfulSearchResults` and `SEARCH_TOOL_NAMES` are no longer where the answer lives. Move
the gate onto the worker's own request bookkeeping — a run that completed no successful
retrieval fails — and delete or repurpose the old mechanism rather than leaving a module that
looks authoritative and counts nothing.

**The model-call budget.** 01 made `JOB_SCOUT_MAX_LLM_CALLS` a per-run computation over
`titles × locations × boards`. That coupling ends here: a Scout that does not search needs a
small fixed ranking budget. Remove the computation rather than leaving it correct-by-accident.

**`run-briefing.ts`'s docblock.** It currently predicts that the fan-out "replaces what produces
`findings` and leaves everything downstream alone". That was true of 01 and is false from here —
this ticket moves work _upstream_ of the Scout, which the docblock does not contemplate. It is
the file's orienting comment; rewrite it.

## The word this ticket does not use

**"Candidate" means the job seeker.** `CONTEXT.md` spends it on the person throughout, and
borrowing it for a search result is the same mistake as borrowing "job" for an employment
opportunity. Say **retrieved Posting** and **retrieval pool**. "Listing" is out too — it sits
on **Posting**'s _Avoid_ list.

**Blocked by:** 01 — Search Indeed alongside SEEK. One board cannot show whether the pooling is
board-neutral.

**Status:** ready-for-agent

- [ ] A Job's configured title/location pairs become inspectable, bounded requests; none are
      left to a model deciding whether to search them
- [ ] A Job exceeding the request budget fails, or reports exactly which requests it did not
      run — verified by a test, not by reading the code
- [ ] Board adapters produce one shared typed retrieved-Posting shape as well as their
      model-facing formatting, so the worker pools without reparsing prose
- [ ] Repeated canonical URLs never reach ranking twice; different URLs across boards are left
      alone for 02
- [ ] The pool is bounded before it reaches the model, with the policy and its per-board
      allocation stated in code and covered by tests
- [ ] The Scout can select only a URL the worker retrieved; an invented or altered URL fails
      before a Brief is written
- [ ] The run-fails-with-no-retrieval gate is evaluated on the worker's request bookkeeping, and
      `successfulSearchResults`/`SEARCH_TOOL_NAMES` are removed or repurposed rather than left
      counting nothing
- [ ] The Scout's model-call ceiling is a small fixed ranking budget again; 01's per-run
      computation is gone
- [ ] `run-briefing.ts`'s pipeline docblock describes the pipeline the file now runs
- [ ] No prose or identifier in this ticket's code calls a retrieved Posting a "candidate"
- [ ] Tests cover a multi-title/multi-location Job, a request-budget overflow, duplicate URLs,
      an explicit exclusion and an invalid selected URL
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
