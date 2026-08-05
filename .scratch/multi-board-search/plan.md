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

### One vocabulary, three dialects

Every board describes a search differently — SEEK wants `"Sydney NSW"`, LinkedIn wants
`"Sydney, New South Wales, Australia"`, LinkedIn's actor wants a whole search _URL_ rather
than parameters, and each spells recency and employment type its own way.

**None of that reaches the model.** All three tools present the same input schema — `query`,
`location`, `maxResults`, `daysOld`, `workType` — and each translates internally to whatever
its actor wants. Where a board's location phrasing genuinely differs, that guidance lives in
**that tool's own `location` field description**, exactly as `seek-search.ts` already spells
out `"Sydney NSW"` in its schema.

This is what lets the system prompt stop naming SEEK. A prompt that had to teach three board
dialects would grow a paragraph per board and get one of them wrong; a schema description
travels attached to the tool it describes, and a board added later brings its own.

### Provenance comes from the URL, not from the model

Grouping needs to know which board a posting came from. Asking the scout to tag each posting
would put provenance in composed output — the exact category `posting-id.ts` refuses to hash
because it is a function of the model's mood.

Instead each search tool exports a small descriptor — its name, and the hosts its results
live on — and `JOB_SCOUT_SEARCH_TOOLS` becomes the list of those. `SEARCH_TOOL_NAMES` keeps
deriving from it exactly as today, the host map derives from it too, and the promise the
existing docblock makes — that adding a board is **one edit in `@workspace/agents`** — stays
true rather than quietly becoming three edits.

### Grouping, above identity and never inside it

`postingId` does not change. It stays URL-derived, stable run to run, and a valid
`@workspace/user-storage` key segment.

A separate pure function groups postings that are plainly the same advertisement on different
boards, after `parseFindings` and before the writer and storage. Its key is normalised
company + normalised title + city token, and it is conservative on purpose:

- **Only across different boards.** Two postings from the same board are never grouped. One
  board listing two similar roles is usually two real openings, and that is precisely the
  merge that must not happen.
- **Ambiguity means no grouping.** If a key matches more than one posting on any single board,
  nothing under that key is grouped. A wrong guess is worse than a duplicate.
- **Fixed board preference decides the survivor** — SEEK, then Indeed, then LinkedIn — so two
  runs seeing the same pair agree on which URL wins, and therefore on the id.

The others survive as an `alsoOn` list on a `ClusteredPosting` type built by code. **`PostingSchema`
is untouched**, because the model is not being asked for any of this.

Known limitation, stated rather than hidden: a posting found on SEEK and Indeed this week and
only on Indeed next week changes its canonical URL and therefore its id. That is already true
today for a posting that moves between boards, it follows from identity being URL-derived, and
the fixed preference order minimises rather than eliminates it.

### Retrieval precedes ranking

Today one model call chain decides which title/location pairs to search, what terms to use,
when it has searched enough, and which returned listings make a Brief. The prompt asks for
one focused search per title and location, but an instruction is not a query plan. On the
current single-board path the result is commonly a few opaque Findings from a search that may
have returned twenty newest listings; widening to three boards would multiply the candidate
context while preserving that blind spot.

Ticket 05 splits this into two responsibilities:

- **The worker plans and retrieves.** It expands configured criteria into an explicit bounded
  request set, calls source adapters, pools typed candidates, removes repeat canonical URLs
  and applies only filters configuration can state exactly. It reports each count.
- **The Scout ranks and explains.** It receives a bounded candidate set, selects only from its
  URLs, and supplies the existing summary, match reason and quoted highlights. It cannot
  silently decide a configured criterion was not worth searching.

This does not turn relevance into a keyword substring test. Seniority, transferable skills and
whether a description is genuinely suitable remain judgement calls, so they stay with the
model. The code owns coverage, source provenance, bounded context and URL identity — things
it can prove. Its evidence gate remains the rule that a selected URL must have come from a
live search result.

### Budget

Two things grow with board count and neither is free.

**Model calls.** `JOB_SCOUT_MAX_LLM_CALLS` is 10, sized when a scout made one focused search
per role title against one board. Three role titles across three boards is nine searches plus
a final answer — the ceiling exactly, with no slack for a retry or a broadened query. It must
rise with board count, and its comment must carry the arithmetic rather than a number someone
later rounds down.

**Context.** Twenty SEEK results with descriptions measured ~79 KB. Three boards at that rate
is a quarter of a megabyte per sweep before the scout has reasoned about any of it.
`MAX_DESCRIPTION_CHARS` bounds each posting and nothing bounds the total. Ticket 03 measures
it. If it bites, the lever is fewer results per board — not a bigger call ceiling, which buys
more searches and therefore more context.

**Money.** Roughly $2–3 per thousand Indeed listings and ~$1 per thousand LinkedIn. A run
pulling 120 listings across boards is well under a dollar; on a daily cadence across users it
is worth watching rather than worth optimising now.

## The thing to decide before ticket 03

`seek-search.ts` records, in its docblock, that the actor is a community scraper and that
SEEK's terms prohibit automated collection — and that using it anyway **was an explicit
product decision, not a technical default**.

LinkedIn is a stronger version of the same question, and it should be answered the same way:
deliberately, in writing, in the tool's docblock. Ticket 03 does not proceed on the assumption
that ticket 01 settled it.
