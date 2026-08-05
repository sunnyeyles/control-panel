# Multi-board search — design

The **Scout** searches one board. This adds two more, and deals with the thing that adding
them breaks.

## What was rejected, and why

**General web search, scoped by domain.** `web_search` already accepts `includeDomains`, so
pointing Tavily at `indeed.com` and `linkedin.com` is a two-line change and the obvious first
idea. It is also the bug commit `93d146d` removed: the diagnosis behind that commit measured
**0 of 3** brief URLs resolving to a live posting, because a search index carries a board's
_browse_ pages rather than its postings, and the posting URLs it does surface are largely
expired. `includeDomains` constrains which sites the index covers. It cannot make the index
carry live inventory. Re-adopting it for two more boards reproduces a fixed bug on a wider
surface.

**Indeed's official APIs.** Job Sync, Indeed Apply, Disposition Sync and Sponsored Jobs are
all partner APIs for publishing _into_ Indeed from an ATS. None exposes a search endpoint.
This is a design decision on Indeed's part, not a gap awaiting an application.

**Indeed's official MCP server.** This one is real, current and genuinely tempting —
`docs.indeed.com/mcp/`, Streamable HTTP, in beta, with job search, job detail, resume and
company-data tools. It was tried live during research and returned ten real Sydney postings.
Three things rule it out for the worker:

- **Its authentication is a person signing in.** The documentation says to sign in with an
  Indeed account and describes the server as available only for Claude Connector. There is no
  documented client-credentials flow. The worker is a Lambda on a cadence with nobody present
  to complete an OAuth handshake.
- **Its URLs are opaque shortlinks** — `to.indeed.com/aah6xpg6bmfq`. `postingId` hashes the
  URL, so a shortlink is an identity we cannot inspect, cannot compare against another board's
  URL for the same posting, and cannot assume is durable. It also contradicts the property
  `seek-search.ts` was written to guarantee: a canonical URL for an individual posting.
- **Descriptions cost a second round trip.** `job_detail` is a separate tool, so a posting's
  description is two model calls rather than riding along with the search as SEEK's
  `fetchDetails` does.

Worth revisiting if Indeed ships server-to-server credentials. Note it stays perfectly usable
from an interactive Claude session today — that is a different environment from the worker,
and the distinction is the whole reason it is rejected here.

**LinkedIn officially, in any form.** There is no public LinkedIn jobs search API. The partner
programme is for _posting_ roles, Sales Navigator's API has stopped accepting new applicants,
and every LinkedIn MCP server on offer is community-built — most wanting either personal
LinkedIn cookies or the public guest endpoint. There is no official path to evaluate.

## The approach

**Apify actors for both, in the shape `seek-search.ts` already established**: a plain `fetch`
against the synchronous run endpoint, the token read inside the call so importing the module
never throws, failure split between _deployment fault_ (throw) and _this one search did not
work_ (return a helpful string). No MCP client in the worker, for the reason already recorded
in that file — a bounded Lambda timeout, and a source that speaks REST.

| Board    | Actor                                 | Cost        | Notes                                            |
| -------- | ------------------------------------- | ----------- | ------------------------------------------------ |
| SEEK     | `unfenced-group/seek-com-au-scraper`  | in place    | —                                                |
| Indeed   | `misceres/indeed-scraper`             | from ~$3/1k | 9 country domains incl. AU; full description     |
| LinkedIn | `curious_coder/linkedin-jobs-scraper` | ~$1/1k      | no cookies; 99.7% run success; 1,000/URL ceiling |

**No new secret and no infrastructure change.** Both actors authenticate with the same
`APIFY_TOKEN` the worker already holds, so there is no Terraform apply and no `⚠️ Before
merging` step on any of these pull requests. That is a deliberate tie-breaker in Apify's
favour over any provider needing its own credential.

**The load-bearing unverified assumption is that these actors return canonical posting URLs.**
Indeed's MCP server is rejected two sections above partly for returning `to.indeed.com`
shortlinks, and nothing guarantees a third-party scraper of the same site does better — it may
well be reading the same decorated or shortened links off a results page. Every other claim
here is either measured or read off a vendor's own documentation; this one is neither, and it
is the one that decides whether `postingId` works at all across boards. 01 and 03 each check it
against URLs the actor actually returned before anything else in the ticket is believed. If an
actor cannot yield a canonical per-posting URL, that board does not ship on that actor, and the
ticket becomes a search for one that does.

### One vocabulary, three dialects

Every board describes a search differently — SEEK wants `"Sydney NSW"`, LinkedIn wants
`"Sydney, New South Wales, Australia"`, LinkedIn's actor wants a whole search _URL_ rather
than parameters, and each spells recency and employment type its own way.

**None of that reaches anything upstream of the board.** All three present the same request
shape — `query`, `location`, `maxResults`, `daysOld`, `workType` — and each translates
internally to whatever its actor wants. Where a board's location phrasing genuinely differs,
that guidance lives with **that board's own `location` field**, exactly as `seek-search.ts`
already spells out `"Sydney NSW"` in its schema.

Before 05 that vocabulary is a tool schema the model fills in, and this is what lets the system
prompt stop naming SEEK: a prompt that had to teach three board dialects would grow a paragraph
per board and get one of them wrong, where a field description travels attached to the thing it
describes. After 05 the same shape is the request record the worker fills in, and the same
property holds one layer up — the planner writes `"Sydney"` once and each board renders it. The
uniformity is what makes the move cheap.

### Provenance comes from the URL, not from the model

Grouping needs to know which board a posting came from. Asking the scout to tag each posting
would put provenance in composed output — the exact category `posting-id.ts` refuses to hash
because it is a function of the model's mood.

Instead each board exports a small descriptor — its name, and the hosts its results live on —
and `JOB_SCOUT_SEARCH_TOOLS` becomes the list of those. The host map derives from it, and the
promise the existing docblock makes — that adding a board is **one edit in
`@workspace/agents`** — stays true rather than quietly becoming three edits.

`SEARCH_TOOL_NAMES` keeps deriving from that list at 01 and stops existing at 05, when the
Scout no longer calls search tools and there are no tool messages left to name. The descriptor
survives that transition unchanged, which is the point of putting board identity in a
descriptor rather than in the tool objects: what a board _is_ outlives how it happens to be
invoked.

**The descriptor also owns that board's tracking parameters, and that is not a detail.**
`TRACKING_PARAMETERS` in `posting-id.ts` is one global set of nine names, and its docblock
states the rule it exists to protect: _anything not on this list is kept, because a query
parameter can genuinely carry a posting's identity_. Indeed decorates links with `from`, `tk`
and `vjk`; pushing those into the global set drops them from SEEK URLs, from LinkedIn URLs and
from every board added after, and `from` is exactly the sort of short generic name another
board could use for something identity-bearing. A set that grows once per board erodes the rule
it is documented under. Scope it by host instead — the descriptor already carries the hosts, so
this is where a per-board set belongs, and the global set stays for names that are tracking
everywhere (`utm_*`, `gclid`, `fbclid`).

### Grouping, above identity and never inside it

`postingId` does not change. It stays URL-derived, stable run to run, and a valid
`@workspace/user-storage` key segment.

A separate pure function groups postings that are plainly the same advertisement on different
boards. **It runs over the retrieval pool, before the Scout ranks** — not over `parseFindings`
output, which was where an earlier draft of this plan put it. Two reasons, and the second is
the one that matters. Grouping afterwards means the model spends context reasoning about three
copies of one advertisement and may well select two of them, so the duplicate is paid for twice
and removed once. And grouping afterwards operates on the eight postings the model already
chose, which is the wrong population: the pool is where both copies are still present.

What the Scout sees is therefore one entry per advertisement, with the other boards named in
the rendered entry as text. Its selection is still one URL — the survivor's — and the worker
reattaches the group to the selected **Posting** by that URL after `parseFindings`. So the
model neither reports provenance nor chooses a survivor; it reads both as facts.

Its key is normalised company + normalised title + city token, and it is conservative on
purpose:

- **Only across different boards.** Two postings from the same board are never grouped. One
  board listing two similar roles is usually two real openings, and that is precisely the
  merge that must not happen.
- **Ambiguity means no grouping.** If a key matches more than one posting on any single board,
  nothing under that key is grouped. A wrong guess is worse than a duplicate.
- **Fixed board preference decides the survivor** — SEEK, then Indeed, then LinkedIn — so two
  runs seeing the same pair agree on which URL wins, and therefore on the id.

The others survive as an `alsoOn` list on a `ClusteredPosting` type built by code. **`PostingSchema`
is untouched**, because the model is not being asked for any of this.

#### Where `alsoOn` is allowed to travel

"`PostingSchema` is untouched" is true and is not the whole answer, because `toNewPostings`
passes each Posting **verbatim** into `postings.payload`, and `payload` is what the dashboard
renders and what the **Letter Writer** is given (`CONTEXT.md`, under **Cover Letter**). A
`ClusteredPosting` handed to it would widen a stored, read-by-two-consumers JSON column by a
field nobody declared. Decide it rather than discover it:

- **Into the writer prompt: yes.** `toWriterPrompt` serialises the findings, and "also listed
  on Indeed" is exactly the kind of thing a brief should be able to say.
- **Into `postings.payload`: yes, and it must be optional.** A Posting found on one board has
  no `alsoOn` and its payload stays byte-for-byte what it is today. Nothing reading the column
  may require the field.
- **Into `PostingSchema`: no.** The schema is the model's contract, and the model does not
  produce this. `ClusteredPosting` extends the parsed type in code.

#### Identity churn is a status-loss bug, not an aesthetic one

A posting found on SEEK and Indeed this week and only on Indeed next week changes its
canonical URL, and therefore its id. The earlier draft filed this as "already true today for a
posting that moves between boards" — which is technically true and practically misleading,
because with one board there is nowhere to move. Grouping is what makes it reachable, and the
common direction is the bad one: SEEK advertisements expire while aggregator copies persist, so
the survivor disappearing out from under the group is the _normal_ case rather than the edge.

What it costs is not a duplicate row. `postings` is keyed `(user_id, posting_id)` and
`status` is **the one column in that schema a person writes** — `postings.ts` names the failure
in as many words, "splitting one Posting into two rows and stranding the status a person set on
the first". A user who marked something `applied` finds it back at `new`, with no record that
it happened.

So it is not accepted as a limitation. Ticket 02 carries an option to evaluate: have the write
path resolve an existing row by **any** URL in the group rather than by the survivor's alone,
so a run that loses the survivor reattaches to the row instead of minting a sibling. That is a
`recordPostings` change and possibly a stored-alias column, which is why it is scoped as a
decision inside 02 rather than assumed here — but shipping 02 without answering it ships a
known way to lose a person's data.

### Retrieval precedes ranking, and lands second

Today one model call chain decides which title/location pairs to search, what terms to use,
when it has searched enough, and which returned postings make a Brief. The prompt asks for
one focused search per title and location, but an instruction is not a query plan. On the
current single-board path the result is commonly a few opaque Findings from a search that may
have returned twenty newest postings; widening to three boards would multiply the retrieved
context while preserving that blind spot.

Ticket 05 splits this into two responsibilities:

- **The worker plans and retrieves.** It expands configured criteria into an explicit bounded
  request set, calls board adapters, pools typed **retrieved Postings**, removes repeat
  canonical URLs, applies only filters configuration can state exactly, and bounds the pool
  before the model sees it. It reports each count.
- **The Scout ranks and explains.** It receives a bounded pool, selects only from its URLs,
  and supplies the existing summary, match reason and quoted highlights. It cannot silently
  decide a configured criterion was not worth searching.

This does not turn relevance into a keyword substring test. Seniority, transferable skills and
whether a description is genuinely suitable remain judgement calls, so they stay with the
model. The code owns coverage, board provenance, bounded context and URL identity — things
it can prove. Its evidence gate remains the rule that a selected URL must have come from a
live search result.

**This ticket moved from last to second, and the ordering was the plan's real mistake.** A
board integration is a different artifact on either side of it: before 05 a board is a tool
the _model_ calls, after 05 it is an adapter the _worker_ calls, and the mechanism that proves
a search happened moves with it. `successfulSearchResults` reads the Scout's `ToolMessage`
stream; after 05 there are no search tool messages to read, so `SEARCH_TOOL_NAMES`, the
per-board count in the run report and the run-killing search gate all move to the worker's own
request bookkeeping. Sequenced last, 05 would have had 01 and 03 each build a board twice, 01
build a per-board count against a mechanism due for retirement, and 04 wire a board filter onto
a tool list that stops being where boards live. Landing it at two boards costs one conversion.

It also removes the coupling in the next section rather than merely surviving it: once the
worker plans the requests, the Scout's model-call ceiling stops scaling with board count at all.

### Budget

Two things grow with board count and neither is free. **A sweep is `titles × locations ×
boards` searches** — an earlier draft of this section wrote `titles × boards` and understated
both figures below by whatever the location count is. `locations` is `.min(1)` with no upper
bound in `JobSearchConfigSchema`, and the system prompt asks for one focused search per role
title _and location_, so the location factor is real and unbounded.

**Model calls.** `JOB_SCOUT_MAX_LLM_CALLS` is 10, sized when a scout made one focused search
per role title against one board. A three-title, two-location Job across three boards is
**eighteen** searches plus a final answer — nineteen model calls against a ceiling of ten, and
the graph routes to `halt`, so what the run produces is a partial answer that still parses.

Raising the constant does not fix this, because there is no constant that fits both a
one-title Job and a five-title, three-location one; pick a number large enough for the second
and the first gets a budget it can wander around inside. **Derive it per run from the parsed
config** — `createJobScout` already takes `maxLlmCalls` as an option (`job-scout.ts`), so the
worker can compute `titles × locations × boards + slack` and pass it. That is ticket 01's job,
and it is temporary: after 05 the Scout does not search, so its ceiling becomes a small fixed
ranking budget and the arithmetic disappears along with the coupling.

**Context.** Twenty SEEK results with descriptions measured ~79 KB — **per search**, not per
board. The earlier draft read that figure as a per-board total and concluded "a quarter of a
megabyte per sweep"; the same three-title, two-location, three-board Job is eighteen searches,
so it is closer to **1.4 MB**, order of 350k tokens, before the Scout has reasoned about any of
it. `MAX_DESCRIPTION_CHARS` bounds each posting and nothing bounds the total.

That is not something to measure later and hope about — at that size the run does not get
slower, it fails. So bounding the pool is part of **05**, not deferred to a measurement ticket:
the worker caps what reaches the model with a stated per-board allocation. The lever is fewer
results per search, never a bigger call ceiling, which buys more searches and therefore more
context. 06 measures what the bound actually does on three live boards.

**Money.** Roughly $2–3 per thousand Indeed postings and ~$1 per thousand LinkedIn. A run
pulling 120 postings across boards is well under a dollar; on a daily cadence across users it
is worth watching rather than worth optimising now.

## The thing to decide before ticket 03

`seek-search.ts` records, in its docblock, that the actor is a community scraper and that
SEEK's terms prohibit automated collection — and that using it anyway **was an explicit
product decision, not a technical default**.

LinkedIn is a stronger version of the same question, and it should be answered the same way:
deliberately, in writing, in that board's own docblock. Ticket 03 does not proceed on the
assumption that ticket 01 settled it.

## Two pieces of prose this work makes wrong

Both are load-bearing documentation that currently describes a system this plan replaces, and
neither is a rename.

**`OVERVIEW.md`, "Not built yet", lists "Several scouts, merged and ranked".** That is this
work, and it is the entry that closes. It closes _differently_ from how it is drawn, which is
the part worth writing down rather than deleting: the fan-out is not several Scouts, it is one
Scout ranking a pool several boards fed. Ticket 03 lands the third board and owns the edit,
including the diagram node.

**`run-briefing.ts`'s docblock predicts the wrong shape.** It says the fan-out "replaces what
produces `findings` and leaves everything downstream alone". True of 01, and false from 05
onward — 05 moves retrieval upstream of the Scout, which the docblock does not contemplate at
all, and it is the file's orienting comment. Ticket 05 rewrites it. A comment that confidently
describes a pipeline the file no longer runs is worse than no comment.
