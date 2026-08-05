# 06 — Measure what retrieval did

**What to build:** enough recorded detail to answer _"why did this brief contain three
postings?"_ without paying to replay the run. 05 made retrieval a thing the worker does rather
than a thing a model decides; this makes what it did visible. The two were one ticket, and are
separated because 05 is a pipeline rewrite that has to land at two boards while this is
reporting that is worth doing once all three exist and there is something to compare.

The pipeline carries these counts through a run and the **Run Report** emits them:

- requests planned, and requests completed
- retrieved Postings, raw
- same-URL duplicates removed
- cross-board groups collapsed (02's contribution — a group of two is one line, not a loss)
- deterministic-filter removals
- retrieved Postings handed to the **Scout**, after the bound
- **Findings** selected

The one-line run report carries the counts. The development trace — `trace.ts`, rendered by the
local harness and absent in production — renders the requests themselves and the pool. **No
production log carries a full advertisement description**: descriptions are several thousand
characters of attacker-influenced text apiece, they are already bounded for the model's sake,
and a log group is not where they earn their keep.

**Measure a real three-board run and write the numbers into the pull request**, not estimates.
Two things are being checked and they have different remedies. Context: whether 05's bound is
holding, and where the pool actually lands relative to it. Cost: Apify is roughly $2–3 per
thousand Indeed postings and ~$1 per thousand LinkedIn, which should be well under a dollar for
a run but has never been observed rather than arithmetic. **If context is tight the lever is
fewer results per request** — never a larger model-call ceiling, which buys more retrieval and
therefore more context.

**Blocked by:** 03 — Search LinkedIn alongside the others. Two of the counts only mean something
once a third board can disagree with the other two, and the measurement is explicitly a
three-board measurement.

**Status:** ready-for-agent

- [ ] The run report distinguishes planned requests, completed requests, retrieved Postings,
      same-URL duplicates removed, cross-board groups collapsed, filter removals, Postings
      handed to the Scout, and Findings selected
- [ ] A board that answered nothing shows `0` rather than being absent, as `countBySource`
      already establishes for search counts
- [ ] The local trace renders the request set and the pool; production logs carry neither a
      description nor a full pool
- [ ] A thin brief can be diagnosed from one run report line — which of retrieval, filtering,
      bounding or ranking removed the postings
- [ ] A real three-board run is measured for context and cost, and the numbers are in the pull
      request
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
