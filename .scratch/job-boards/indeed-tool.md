# Indeed search tool

An `indeed_search` tool so the Scout can look at Indeed as well as SEEK. Same idea as
`packages/agent-tools/src/seek-search.ts` — Apify actor, plain `fetch`, `APIFY_TOKEN`.

Actor: **`misceres/indeed-scraper`**. Healthy — 99.5% success over 153k runs.

## What it does

Takes the same five fields SEEK's tool takes (`query`, `location`, `maxResults`,
`daysOld`, `workType`) and translates them to what the actor wants. The model shouldn't
have to know it's talking to a different board.

## What the actor actually wants

Confirmed by running it on 2026-08-05.

```json
{
  "position": "software engineer",
  "country": "AU",
  "location": "Sydney NSW",
  "maxItemsPerSearch": 6,
  "saveOnlyUniqueItems": true,
  "parseCompanyDetails": false,
  "followApplyRedirects": false
}
```

Took ~15–20s. There's no `daysOld` equivalent in the input schema — recency has to come
from filtering `postingDateParsed` after the fact, or from the search query. Worth a look.

## What comes back

```
url                 https://au.indeed.com/viewjob?jk=e84cd445a1ea8a30
id                  e84cd445a1ea8a30
positionName        Senior Software Engineer
company             …
location            …
description         full text, 3.5k–8.1k chars, present on all 6
postingDateParsed   2026-08-05T00:50:35.310Z
isExpired           false
jobType, salary     sometimes
externalApplyLink   sometimes — ignore it
```

## Things worth knowing

**URLs are canonical and stable.** `?jk=` is the identity. Ran the search twice and all
4 overlapping postings hashed to the same `postingId`. Nothing needs fixing here.

**Don't touch `externalApplyLink`.** That's where the `from`/`tk`/`vjk` tracking junk
lives. The `url` field is clean.

**It's heavy.** 77 KB of JSON for 6 results — roughly 4× SEEK per posting, because the
descriptions are longer. SEEK defaults to 20 results per search; Indeed should default to
something a lot lower or the Scout's context gets eaten.

**Cost.** $0.036 for 6 items, so ~$6 per thousand. The listing says ~$3 — small batches
seem to cost more per item. Not a problem at our volume.

## Once it exists

- Register it wherever `seek_search` is registered so the Scout gets both.
- `JOB_SCOUT_SYSTEM_PROMPT` currently says the Scout works "by searching SEEK's live
  listings" and tells it to write locations "the way SEEK writes them". Both wrong with
  two boards — make it board-neutral.
- `JOB_SCOUT_MAX_LLM_CALLS` is 10 and a sweep is now `titles × locations × boards`. Easy
  to blow through. `createJobScout` already takes `maxLlmCalls`, so compute it instead.
- Briefs will show the same posting twice when it's on both boards. Fine for now.
