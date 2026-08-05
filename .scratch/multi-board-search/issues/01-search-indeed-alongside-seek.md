# 01 — Search Indeed alongside SEEK

**What to build:** the **Scout** carries a second board. Today it carries `seek_search`
alone, so a **Briefing** covers seek.com.au and a candidate who reads Indeed is told
about a slice of what is open. After this ticket a brief cites postings from both, and
the run report counts them separately.

A new `indeed_search` over Apify's `misceres/indeed-scraper`, built as a near-mirror of
`packages/agent-tools/src/seek-search.ts`: same synchronous run endpoint, same
`APIFY_TOKEN` read inside the call so importing the module never throws, same split
between a rejected token (throw — a deployment fault no rephrasing fixes) and any other
failure (return a sentence the Scout can act on).

**Export a typed function with a thin `tool()` wrapper on top**, as `apifySeekSearch` and
`seekSearch` already are, and have the function return structured results as well as the
formatted string. 05 then changes who calls it rather than rebuilding the board.

**Its input schema is SEEK's five fields** — `query`, `location`, `maxResults`,
`daysOld`, `workType` — translated inside to what the actor wants. Board-specific
phrasing belongs in this tool's own `location` description, as SEEK's already carries
`"Sydney NSW"`.

## Known actor behaviour, measured 2026-08-05

Verified live, so build against these rather than rediscovering them:

- **Request**: `position`, `country: "AU"`, `location`, `maxItemsPerSearch`,
  `saveOnlyUniqueItems: true`, `parseCompanyDetails: false`,
  `followApplyRedirects: false`. Roughly 15–20s for a small search.
- **Response fields**: `url`, `positionName`, `company`, `location`, `description`,
  `postingDateParsed` (ISO), `isExpired`, `jobType`, `salary`.
- **URLs are canonical** — `https://au.indeed.com/viewjob?jk=e84cd445a1ea8a30`, and ids
  were stable across two runs (4 of 4). `jk` is identity; 00 already ensures nothing
  strips it. The `from`/`tk`/`vjk` parameters live on `externalApplyLink`, which this
  tool does not read.
- **Descriptions are always present** and ran 3.5k–8.1k characters, so reuse SEEK's
  `MAX_DESCRIPTION_CHARS` bound and its truncation notice.
- **Context is ~4× SEEK's per posting** — 77 KB for six results. Default `maxResults`
  well below SEEK's 20, and say why in the constant's comment.

## Three changes beyond adding a file

- **The system prompt stops naming SEEK.** `JOB_SCOUT_SYSTEM_PROMPT` says the Scout works
  "by searching SEEK's live listings" and to pass locations "the way SEEK writes them".
  Both are now false in the general case. Make it board-neutral and let each tool's schema
  carry its own board's phrasing.
- **The model-call budget becomes a per-run number, not a bigger constant.**
  `JOB_SCOUT_MAX_LLM_CALLS` is 10, sized for one search per title against one board. A
  sweep is `titles × locations × boards`, and `locations` has no cap — a three-title,
  two-location Job across two boards is twelve searches, and the graph routes to `halt` at
  ten with a partial answer that still parses. `createJobScout` already accepts
  `maxLlmCalls`; have the worker compute it and pass it, keeping the constant as the floor
  for a caller that supplies nothing. Put the arithmetic in the comment. **Temporary** —
  05 stops the Scout searching and the ceiling reverts to a fixed ranking budget.
- **`sources` stops claiming to be a switch.** Its description in `job-search-config.ts`
  calls itself a soft hint. With one board that was harmless; from here a Job naming
  `seek.com.au` receives Indeed postings. Say in the description that it records boards
  the candidate follows and does not currently restrict anything. 04 makes it real.

**Known and accepted, both to be said on the pull request:** until 03, a posting on both
boards appears twice in a brief; until 04, a Job naming one board is searched on all of
them.

**Blocked by:** 00 — Scope tracking parameters per board.

**Status:** ready-for-agent

- [ ] `indeed_search` returns currently-open Indeed postings for a query and location,
      each with its canonical URL, listing date and the advertisement's own description
- [ ] The board is a typed exported function with a thin `tool()` wrapper, and the
      function's return type carries the fields a caller needs without reparsing prose
- [ ] Its input schema matches SEEK's five fields; nothing board-specific reaches the
      model except through this tool's own field descriptions
- [ ] A rejected `APIFY_TOKEN` throws; a failed run, a rate limit or an unparseable body
      comes back as a string telling the Scout to continue
- [ ] Unit tests drive it with an injected `fetch`, as `seek-search.test.ts` does, and
      cover both failure postures
- [ ] Indeed is registered as a board descriptor; no second list of board names exists
- [ ] The system prompt names no board, and a run searches both
- [ ] The model-call budget is computed per run from `titles × locations × boards` and
      passed through `createJobScout`, with a test showing a multi-criterion Job gets a
      larger budget than a single-criterion one
- [ ] Default results per search are bounded for Indeed's measured payload size, with the
      reason in the code
- [ ] `sources`'s description no longer implies it restricts anything
- [ ] The run report counts searches per board; a board that answered nothing shows `0`
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**Verify end to end** with a real run against a live `APIFY_TOKEN`: a brief whose
postings include both SEEK and Indeed URLs, every one opening a live advertisement. The
gate in `run-briefing.ts` already fails a run reporting a URL that did not appear
verbatim in a search result — confirm that still holds with two boards rather than
assuming it.
