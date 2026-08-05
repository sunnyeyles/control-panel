# 06 — Measure what retrieval did

**What to build:** enough recorded detail to answer _"why did this brief contain three
postings?"_ without paying to replay the run.

The pipeline carries these counts and the **Run Report** emits them:

- searches or requests planned, and completed
- retrieved Postings, raw
- same-URL duplicates removed
- cross-board groups collapsed (03's contribution — a group of two is one line, not a loss)
- deterministic-filter removals
- retrieved Postings handed to the **Scout**, after the bound
- **Findings** selected

The one-line run report carries the counts. The development trace — `trace.ts`, rendered
by the local harness and absent in production — renders the requests and the pool. **No
production log carries a full advertisement description**: they are several thousand
characters of attacker-influenced text apiece, already bounded for the model's sake, and
a log group is not where they earn their keep.

**Measure a real three-board run and write the numbers into the pull request**, not
estimates. Two things are being checked and they have different remedies. Context: where
the pool actually lands relative to its bound — the spike measured Indeed at 77 KB for six
results and LinkedIn at 86 KB for ten, against SEEK's ~79 KB for twenty, so the per-board
allocation is unlikely to be uniform. Cost: the spike observed ~$6 per thousand Indeed
postings at small batch sizes and ~$1.1 per thousand LinkedIn, against listing prices of
~$3 and ~$1 — check what a real run costs rather than what the listing says. **If context
is tight the lever is fewer results per search**, never a larger model-call ceiling, which
buys more retrieval and therefore more context.

**Blocked by:** 03 — Collapse a posting found on two boards. The group count needs
grouping, and the measurement is explicitly a three-board one.

**Status:** ready-for-agent

- [ ] The run report distinguishes planned and completed requests, retrieved Postings,
      same-URL duplicates removed, cross-board groups collapsed, filter removals, Postings
      handed to the Scout, and Findings selected
- [ ] A board that answered nothing shows `0` rather than being absent, as `countBySource`
      already establishes
- [ ] The local trace renders the request set and the pool; production logs carry neither
      a description nor a full pool
- [ ] A thin brief can be diagnosed from one run report line — which of retrieval,
      filtering, bounding or ranking removed the postings
- [ ] A real three-board run is measured for context and cost, and the numbers are in the
      pull request
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
