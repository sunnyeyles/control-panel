# Multi-board search — design

The **Scout** searches one board. This adds two more, and deals with the thing that
adding them breaks.

## Measured, on 2026-08-05

Both actors were run live against a Sydney "software engineer" search before any of this
was written. The numbers below are observations, not estimates, and the tickets are
built on them.

|                                    | Indeed (`misceres/indeed-scraper`)                  | LinkedIn (`curious_coder/linkedin-jobs-scraper`)   |
| ---------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| URL returned                       | `https://au.indeed.com/viewjob?jk=e84cd445a1ea8a30` | `https://au.linkedin.com/jobs/view/{slug}-4446494860` |
| Identity in                        | the `jk` query parameter                            | the path                                           |
| `postingId` stable across two runs | **4 of 4**                                          | **0 of 9**                                         |
| Description                        | 6/6, 3.5k–8.1k chars                                | 10/10, 2.5k–4.8k chars                             |
| Title, company, date, location     | 6/6                                                 | 10/10                                              |
| Payload per search                 | 77 KB / 6 results                                   | 86 KB / 10 results                                 |
| Observed cost                      | $0.036 / 6 items (~$6 per 1k)                       | $0.011 / 10 items (~$1.1 per 1k)                   |
| Actor health                       | 99.5% success over 153k runs                        | 98.7% over 366k                                    |

**Canonical per-posting URLs, confirmed.** Neither actor returns a shortlink. That was
this plan's one load-bearing unverified assumption, and it holds — so cross-board
grouping is buildable.

**LinkedIn's `postingId` is unstable on every run, and that is ticket 00.** Its URLs
carry `position`, `pageNum`, `refId` and `trackingId`; the last two are regenerated per
search. None is in `TRACKING_PARAMETERS`, none starts with `utm_`, so all four reach the
hash. Two runs twenty seconds apart agreed on zero of nine ids:

```
run1  3c2ccd59cf66c9bb  …-4446494860?position=60&…&refId=Is5ZuQho…&trackingId=D+HsFbhL…
run2  3cbcd7167f8f18ac  …-4446494860?position=60&…&refId=VFISQlvQ…&trackingId=j2rmVDCP…
```

Stripping those four per-host gives 9 of 9. This is the status-loss failure `postings.ts`
names — a person who marked something `applied` finds it back at `new` — and it fires on
every LinkedIn run with a single board, long before grouping exists.

**Indeed's `url` field is clean.** An earlier draft warned that Indeed decorates links
with `from`, `tk` and `vjk`. It does — on `externalApplyLink`, which nothing here reads.
`url` is a bare `?jk=`, and `jk` **is** the identity and must survive normalisation.

**Two smaller facts.** The LinkedIn actor rejects `count < 10`, which its adapter absorbs
rather than passing upstream. And Indeed costs roughly 4× SEEK's context per posting
(77 KB for 6 results against SEEK's ~79 KB for 20), so a pool bound is not optional.

## Rejected, with the reason

| Option                                       | Why not                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tavily scoped by `includeDomains`            | The bug `93d146d` removed. `includeDomains` picks which sites an index covers, not whether it carries live postings; the diagnosis measured **0 of 3** brief URLs resolving to a live posting.                                                                                                                                                |
| Indeed's Job Sync / Apply / Sponsored Jobs   | All publish _into_ Indeed from an ATS. None exposes a search endpoint.                                                                                                                                                                                                                                                                       |
| Indeed's official MCP server                 | Real and current, and it returned ten live Sydney postings when tried. But it authenticates by a **person signing in**, is documented as Claude Connector only, and returns opaque `to.indeed.com` shortlinks `postingId` cannot compare across boards. Fine from an interactive session; the worker is a Lambda with nobody present. Revisit if server-to-server credentials ship. |
| LinkedIn, officially                         | No public jobs search API. The partner programme is for _posting_ roles, Sales Navigator has stopped accepting applicants, and every MCP server on offer is community-built.                                                                                                                                                                  |

## The approach

**Apify actors for both, in the shape `seek-search.ts` already established**: plain
`fetch` against the synchronous run endpoint, the token read inside the call so importing
the module never throws, failure split between _deployment fault_ (throw) and _this one
search did not work_ (return a helpful string).

**No new secret and no Terraform apply.** Both actors use the `APIFY_TOKEN` the worker
already holds. No ticket here carries a `⚠️ Before merging` step.

### One vocabulary, three dialects

Every board describes a search differently — SEEK wants `"Sydney NSW"`, LinkedIn wants a
whole search _URL_ rather than parameters, and each spells recency and employment type
its own way. **None of that reaches anything upstream of the board.** All three present
`query`, `location`, `maxResults`, `daysOld`, `workType` and translate internally.
Board-specific phrasing lives in that board's own `location` field description, exactly
as `seek-search.ts` already spells out `"Sydney NSW"`.

That is what lets the system prompt stop naming SEEK: a prompt teaching three dialects
grows a paragraph per board and gets one of them wrong.

### Every board is a typed function with a tool on top

`seek-search.ts` already has this shape — `apifySeekSearch` does the work, `seekSearch`
is a thin `tool()` wrapper. **Each new board follows it, and its function returns typed
results as well as the formatted string.**

That is what keeps 05 off the critical path. This plan used to sequence worker-owned
retrieval second so that boards were not built twice, as tools and then as adapters.
With a typed function already exported, 05 changes who calls it and deletes the wrapper —
so boards, grouping and `sources` no longer wait on a pipeline rewrite, and 05 lands
whenever it is worth landing.

### Provenance comes from the URL, not from the model

Grouping needs to know which board a posting came from. Asking the Scout to tag each one
would put provenance in composed output — the category `posting-id.ts` refuses to hash.

Each board exports a **descriptor**: its name, the hosts its results live on, and the
query parameters that are tracking _on those hosts_. `JOB_SCOUT_SEARCH_TOOLS` becomes the
list of those, the host map derives from it, and the existing docblock's promise — that
adding a board is one edit in `@workspace/agents` — stays true.

**Per-host tracking parameters are why the descriptor exists**, not a tidiness argument.
`TRACKING_PARAMETERS` is one global set of nine names under a documented rule: _anything
not on this list is kept, because a query parameter can genuinely carry a posting's
identity_. Pushing LinkedIn's `refId` and `position` into it would drop `position` from
every board added after, and the measurement above shows LinkedIn cannot ship without
them being dropped somewhere. Scope them to the hosts they are tracking on.

### Grouping, above identity and never inside it

`postingId` does not change. A separate pure function groups postings that are plainly
the same advertisement on different boards, keyed on normalised company + normalised
title + city token, and conservative on purpose:

- **Only across different boards.** One board listing two similar roles is usually two
  real openings, and that is precisely the merge that must not happen.
- **Ambiguity groups nothing.** If a key matches more than one posting on any single
  board, nothing under it is grouped.
- **Fixed board preference picks the survivor** — SEEK, then Indeed, then LinkedIn — so
  two runs seeing the same pair agree on the URL and therefore on the id.

The others survive as an optional `alsoOn` list on a `ClusteredPosting` built in code.
**`PostingSchema` is untouched**, because the model is not asked for any of this.

### Budget

**A sweep is `titles × locations × boards` searches.** `locations` is `.min(1)` with no
upper bound in `JobSearchConfigSchema`, so a three-title two-location Job across three
boards is eighteen searches plus a final answer — nineteen model calls against
`JOB_SCOUT_MAX_LLM_CALLS` of 10, and the graph routes to `halt` with a partial answer
that still parses.

No constant fits both that Job and a one-title one, so **derive it per run**;
`createJobScout` already takes `maxLlmCalls`. Eighteen searches at Indeed's measured
77 KB is order of 1.4 MB and 350k tokens before the Scout reasons about any of it, which
does not get slower, it fails. So bounding results per search is part of shipping a
second board, not something to measure later. **The lever is fewer results per search** —
never a bigger call ceiling, which buys more searches and therefore more context.

**Money.** Under a dollar for a run pulling 120 postings across boards. Worth watching on
a daily cadence across users, not worth optimising now.

## Decide before the LinkedIn ticket

`seek-search.ts` records in its docblock that the actor is a community scraper, that
SEEK's terms prohibit automated collection, and that using it anyway **was an explicit
product decision, not a technical default**. LinkedIn is a stronger version of the same
question and gets the same treatment, in its own docblock. Ticket 02 does not inherit
ticket 01's answer.

## Two pieces of prose this work makes wrong

**`OVERVIEW.md`, "Not built yet", lists "Several scouts, merged and ranked".** That is
this work, and it closes _differently_ from how it is drawn: the fan-out is not several
Scouts, it is one Scout ranking a pool that several boards fed. Ticket 02 owns the edit,
including the diagram node.

**`run-briefing.ts`'s docblock** says the fan-out "replaces what produces `findings` and
leaves everything downstream alone". True of the board tickets, false from 05, which
moves retrieval upstream of the Scout. Ticket 05 rewrites it.
