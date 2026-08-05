# 01 — Search Indeed alongside SEEK

**What to build:** the **Scout** carries a second board. Today it carries `seek_search` and
nothing else, so a **Briefing** covers seek.com.au and a candidate who reads Indeed is told
about a slice of what is open. After this ticket a brief cites postings from both, and the
run report counts them separately.

A new `indeed_search` tool over Apify's `misceres/indeed-scraper`, built as a near-mirror of
`packages/agent-tools/src/seek-search.ts` — same synchronous run endpoint, same `APIFY_TOKEN`
read inside the call so importing the module never throws, same split between a rejected token
(throw; a deployment fault no rephrasing fixes) and any other failure (return a sentence the
scout can act on). Read that file first and follow it; where this ticket is silent, it is
because the answer is to do what SEEK does.

**Its input schema is the same five fields SEEK's is** — `query`, `location`, `maxResults`,
`daysOld`, `workType` — translated inside the tool to whatever the actor wants. The scout must
not learn a second dialect; see the vocabulary section of `plan.md`. Board-specific phrasing
belongs in this tool's own `location` description, as SEEK's already carries `"Sydney NSW"`.

Three things this ticket changes beyond adding a file:

- **`JOB_SCOUT_SEARCH_TOOLS` becomes a list of descriptors, not bare tools.** Grouping in
  ticket 02 needs to know which hosts belong to which board, and the docblock at
  `packages/agents/src/job-scout.ts` promises adding a board is one edit in one package.
  Export a small descriptor per tool — its tool, and the hosts its results live on — and
  derive `SEARCH_TOOL_NAMES` from it exactly as `search-results.ts` derives it today. Nothing
  downstream should need a second list.
- **The system prompt stops naming SEEK.** `JOB_SCOUT_SYSTEM_PROMPT` currently says the scout
  works "by searching SEEK's live listings" and tells it to pass locations "the way SEEK writes
  them". Both are now false in the general case. Make the prompt board-neutral and let each
  tool's schema carry its own board's phrasing.
- **`JOB_SCOUT_MAX_LLM_CALLS` rises.** Ten was sized for one focused search per role title
  against one board. Two boards doubles the searches before the scout has answered anything.
  Raise it, and put the arithmetic in the comment — a bare number gets rounded down by someone
  who does not know what it was derived from.

**Watch the URLs the actor returns.** `postingId` hashes the URL after dropping `utm_*` and a
named list of tracking parameters, and Indeed decorates its links with provenance the list has
never seen — `from`, `tk`, `vjk` and friends. Left in, the same posting hashes differently
between two runs and the brief re-reports it as new. `jk` is identity and must survive; check
against real returned URLs rather than against this paragraph, and add only what is genuinely
provenance.

**Known and accepted:** between this ticket and 02, a posting listed on both boards appears
twice in a brief. Grouping cannot be built before something produces duplicates. Say so on the
pull request, and do not leave 02 long behind.

**Blocked by:** —

**Status:** ready-for-agent

- [ ] `indeed_search` returns currently-open Indeed postings for a query and location, each
      with a canonical Indeed URL, its listing date and the advertisement's own description
- [ ] Its input schema matches SEEK's five fields; nothing board-specific reaches the model
      except through this tool's own field descriptions
- [ ] A rejected `APIFY_TOKEN` throws; a failed run, a rate limit or an unparseable body comes
      back as a string that tells the scout to continue
- [ ] Unit tests drive the tool with an injected `fetch`, as `seek-search.test.ts` does, and
      cover both failure postures
- [ ] `JOB_SCOUT_SEARCH_TOOLS` carries board descriptors; `SEARCH_TOOL_NAMES` still derives
      from it and no second list of board names exists anywhere
- [ ] The system prompt names no board; a scout run makes searches against both
- [ ] `JOB_SCOUT_MAX_LLM_CALLS` is raised and its comment shows the arithmetic
- [ ] Indeed provenance parameters are dropped by `normalisePostingUrl`, verified against URLs
      the actor actually returned — the same posting twice in one run yields one id
- [ ] The run report counts searches per board, and a board that answered nothing shows `0`
      rather than being absent
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**Verify it end to end** with a real run against a live `APIFY_TOKEN`: a brief whose postings
include both `seek.com.au` and Indeed URLs, every one of which opens a live advertisement. The
gate in `run-briefing.ts` already checks each reported URL appeared verbatim in a search
result, so a fabricated Indeed URL fails the run rather than reaching a brief — confirm that
still holds with two boards rather than assuming it.
