# 01 — Search Indeed alongside SEEK

**What to build:** the **Scout** carries a second board. Today it carries `seek_search` and
nothing else, so a **Briefing** covers seek.com.au and a candidate who reads Indeed is told
about a slice of what is open. After this ticket a brief cites postings from both, and the
run report counts them separately.

A new `indeed_search` tool over Apify's `misceres/indeed-scraper`, built as a near-mirror of
`packages/agent-tools/src/seek-search.ts` — same synchronous run endpoint, same `APIFY_TOKEN`
read inside the call so importing the module never throws, same split between a rejected token
(throw; a deployment fault no rephrasing fixes) and any other failure (return a sentence the
scout can act on).

**Its input schema is the same five fields SEEK's is** — `query`, `location`, `maxResults`,
`daysOld`, `workType` — translated inside the tool to whatever the actor wants. Board-specific
phrasing belongs in this tool's own `location` description, as SEEK's already carries
`"Sydney NSW"`.

Four things this ticket changes beyond adding a file:

- **`JOB_SCOUT_SEARCH_TOOLS` becomes a list of descriptors, not bare tools.** Export each
  tool with the hosts its results live on. Keep `SEARCH_TOOL_NAMES` deriving from that list, so
  board provenance has one registry and no downstream second list.
- **The system prompt stops naming SEEK.** `JOB_SCOUT_SYSTEM_PROMPT` currently says the scout
  works "by searching SEEK's live listings" and tells it to pass locations "the way SEEK writes
  them". Both are now false in the general case. Make the prompt board-neutral and let each
  tool's schema carry its own board's phrasing.
- **The model-call budget becomes a per-run number, not a bigger constant.** `JOB_SCOUT_MAX_LLM_CALLS`
  is 10, sized for one focused search per role title against one board. The prompt asks for one
  search per title **and location**, and `locations` is `.min(1)` with no cap, so a sweep is
  `titles × locations × boards`: a three-title, two-location Job across two boards is twelve
  searches before it answers, and the graph routes to `halt` at ten with a partial answer that
  still parses. No constant fits both that Job and a one-title one. `createJobScout` already
  accepts `maxLlmCalls` as an option — have the worker compute it from the parsed config and
  pass it, keeping the constant as the floor for a caller that supplies nothing. Put the
  arithmetic in the comment; a bare number gets rounded down by someone who does not know what
  it was derived from. **This is temporary** — 05 stops the Scout searching at all, and the
  ceiling reverts to a small fixed ranking budget.
- **`sources` stops claiming to be a switch.** The field's description in `job-search-config.ts`
  calls itself a soft hint and the prompt tells the scout to "search the ones your tools reach".
  With one board that was harmless. From this ticket a Job naming `seek.com.au` receives Indeed
  postings, so say so in the description — that it records boards the candidate follows and does
  not currently restrict anything. 04 makes it real; this stops it lying in the meantime.

**Watch the URLs the actor returns, and scope what you strip.** `postingId` hashes the URL
after dropping `utm_*` and a named list of tracking parameters, and Indeed decorates its links
with provenance the list has never seen — `from`, `tk`, `vjk` and friends. Left in, the same
posting hashes differently between two runs and the brief re-reports it as new. `jk` is
identity and must survive.

Two constraints on how you strip them. Check against **real returned URLs** rather than against
this paragraph — that the actor yields a canonical `/viewjob?jk=…` URL at all is this plan's
one unverified load-bearing assumption, and if it returns shortlinks instead, this ticket
becomes a search for an actor that does not. And **scope the new names to Indeed's hosts**, on
the descriptor this ticket already introduces, rather than appending them to the global
`TRACKING_PARAMETERS` set: that set's docblock states the rule it protects — anything not
listed is kept, because a parameter can carry identity — and a generic name like `from` dropped
globally silently reaches SEEK, LinkedIn and every board added after.

**Known and accepted, both to be said on the pull request:**

- Between this ticket and 02, a posting listed on both boards appears twice in a brief.
  Grouping cannot be built before something produces duplicates.
- Between this ticket and 04, a Job naming one board is searched on all of them. The
  description change above makes that visible rather than fixing it.

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
- [ ] The URLs the actor returns are canonical per-posting Indeed URLs, confirmed against a
      real run — not shortlinks. If they are shortlinks, stop and re-open the actor choice
      rather than building on them
- [ ] `JOB_SCOUT_SEARCH_TOOLS` carries board descriptors; `SEARCH_TOOL_NAMES` still derives
      from it and no second list of board names exists anywhere
- [ ] The system prompt names no board; a scout run makes searches against both
- [ ] The model-call budget is computed per run from `titles × locations × boards`, passed
      through `createJobScout`, and covered by a test showing a multi-title multi-location Job
      gets a larger budget than a single-criterion one
- [ ] Indeed provenance parameters are dropped by `normalisePostingUrl` **for Indeed's hosts
      only**, verified against URLs the actor actually returned — the same posting twice in one
      run yields one id, and a SEEK URL carrying `from=` is unaffected
- [ ] `sources`'s description no longer implies it restricts anything
- [ ] The run report counts searches per board, and a board that answered nothing shows `0`
      rather than being absent
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**Verify it end to end** with a real run against a live `APIFY_TOKEN`: a brief whose postings
include both `seek.com.au` and Indeed URLs, every one of which opens a live advertisement. The
gate in `run-briefing.ts` already checks each reported URL appeared verbatim in a search
result, so a fabricated Indeed URL fails the run rather than reaching a brief — confirm that
still holds with two boards rather than assuming it.
