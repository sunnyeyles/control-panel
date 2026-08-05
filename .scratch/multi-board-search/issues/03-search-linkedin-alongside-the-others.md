# 03 — Search LinkedIn alongside the others

**What to build:** the third board. A `linkedin_search` tool over Apify's
`curious_coder/linkedin-jobs-scraper`, wired in exactly as ticket 01 wired Indeed — one entry
in `JOB_SCOUT_SEARCH_TOOLS`, everything downstream deriving from it.

Two things make this more than ticket 01 again.

**The actor takes a search URL, not parameters.** It wants a linkedin.com/jobs search URL with
the filters already applied, so this tool has to build one: keywords and location into the
query string, `daysOld` into LinkedIn's seconds-based recency filter, `workType` into its
employment-type codes. That translation lives inside the tool and is unit-testable on its own.
**The tool's input schema stays the same five fields the other two present** — the scout does
not learn that one board is different, which is the whole point of the vocabulary rule in
`plan.md`. LinkedIn also caps a single search URL at 1,000 results; well past anything a scout
asks for, but worth a comment so the next person does not rediscover it.

**The terms question has to be answered before this is written, not after.**
`seek-search.ts` records in its docblock that its actor is a community scraper, that SEEK's
terms prohibit automated collection, and that using it anyway was **an explicit product
decision rather than a technical default**. LinkedIn is a harder version of that question and
deserves its own answer in its own docblock, in the same plain terms. Ticket 01 did not settle
it and this ticket must not inherit it silently. The actor at least runs without cookies or a
LinkedIn account, so no personal account is making the requests — say that too, because it is
the part that materially lowers the risk.

**This is also where the budget gets measured.** Three boards is where the context arithmetic
in `plan.md` stops being theoretical: twenty results with descriptions ran ~79 KB on SEEK, and
nothing bounds the total across boards. Measure a real three-board run. If it is tight, reduce
results per board — do not raise the call ceiling, which buys more searches and so more
context.

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
- [ ] Grouping from ticket 02 collapses an advertisement listed on all three boards into one
      Posting with two entries in `alsoOn`
- [ ] `JOB_SCOUT_MAX_LLM_CALLS` is raised again and its comment still shows the arithmetic
- [ ] A real three-board run is measured for context and cost, and the numbers are written into
      the pull request rather than estimated
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
