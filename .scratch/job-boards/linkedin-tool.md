# LinkedIn search tool

A `linkedin_search` tool, same shape as the SEEK and Indeed ones.

Actor: **`curious_coder/linkedin-jobs-scraper`**. 98.7% success over 366k runs.

There's no official option here — LinkedIn has no public jobs search API, the partner
programme is for posting roles, and every MCP server on offer is community-built and
wants your personal cookies. This actor at least doesn't need an account.

## The awkward bit

**It takes a search URL, not parameters.** You hand it
`https://www.linkedin.com/jobs/search/?keywords=…&location=…` with the filters already
baked in. So the tool has to build that URL: keywords and location into the query string,
`daysOld` into LinkedIn's seconds-based recency filter, `workType` into its
employment-type codes.

That's all internal. From the outside it takes the same five fields the other two do.

## What the actor wants

```json
{
  "urls": [
    "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Sydney%2C%20New%20South%20Wales%2C%20Australia"
  ],
  "count": 10,
  "scrapeCompany": false
}
```

~20–30s. **`count` has a hard floor of 10** — anything less is rejected outright with
`Field input.count must be >= 10`. Just clamp up and slice; don't leak that upward.

One search URL caps out at 1,000 results.

## What comes back

```
link            https://au.linkedin.com/jobs/view/software-engineer-at-simplus-anz-…-4446494860?position=…
id              4446494860
title           …
companyName     …
location        …
descriptionText present on all 10, 2.5k–4.8k chars
postedAt        2026-07-30   (date only, no time)
employmentType, seniorityLevel, salary, applicantsCount
applyUrl        empty string on every single result — ignore it
```

Note the host comes back as `au.linkedin.com` even though we asked `www.linkedin.com`.

## The thing that will bite

**LinkedIn URLs carry per-search tracking junk and it breaks `postingId`.**

The URLs arrive with `?position=&pageNum=&refId=&trackingId=`. `refId` and `trackingId`
are regenerated on every search. `postingId` hashes the URL after stripping `utm_*` and
nine named parameters — none of which are these — so the same posting gets a different id
every run.

Ran the same search twice, 20 seconds apart. **Zero of nine postings kept their id.**

```
run1  3c2ccd59cf66c9bb  …-4446494860?position=60&…&refId=Is5ZuQho…&trackingId=D+HsFbhL…
run2  3cbcd7167f8f18ac  …-4446494860?position=60&…&refId=VFISQlvQ…&trackingId=j2rmVDCP…
```

That's not cosmetic — `postings` is keyed on `(user_id, posting_id)` and `status` is the
column a person sets. Every run would mint new rows and lose whatever you'd marked
`applied`.

Strip those four and it's 9 of 9 stable. **Do this before shipping the tool, not after.**
And strip them for LinkedIn's hosts only — `position` is a generic enough name that
dropping it globally would eventually eat something real on another board.

Still churns if a posting gets retitled, since the slug is title-derived. Living with that
for now.

## Cost

$0.011 for 10 items, ~$1.10 per thousand. Cheapest of the three.

## Terms

Same question as SEEK, but louder. `seek-search.ts` writes down in its docblock that the
actor is a community scraper, that SEEK's terms prohibit automated collection, and that we
did it anyway on purpose. LinkedIn needs its own version of that paragraph — worth an
actual decision rather than inheriting SEEK's.
