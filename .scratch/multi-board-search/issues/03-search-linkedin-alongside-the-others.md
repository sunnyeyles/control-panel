# 03 — Search LinkedIn alongside the others

**What to build:** the third board. A LinkedIn board over Apify's
`curious_coder/linkedin-jobs-scraper`, registered in `packages/agents/src/job-scout.ts` with
the other board descriptors.

**It is an adapter the worker calls, not a tool the model calls.** 05 moved retrieval into the
worker, so a board now exposes a typed retrieval function and its descriptor rather than a
LangChain tool the Scout picks. Build it in that shape from the start — this is the whole
reason 05 was resequenced ahead of this ticket, and building a tool here and converting it
afterwards is exactly the rework the reordering exists to avoid.

**The actor takes a search URL, not parameters.** It wants a linkedin.com/jobs search URL with
the filters already applied, so this adapter has to build one: keywords and location into the
query string, `daysOld` into LinkedIn's seconds-based recency filter, `workType` into its
employment-type codes. That translation lives inside the adapter and is unit-testable on its
own. **Its request shape stays the same five fields the other two present** — nothing about
LinkedIn being different reaches anything upstream of the adapter. LinkedIn also caps a single
search URL at 1,000 results; record that limit beside the URL builder.

**The terms position must be decided before implementation and recorded in the adapter's
docblock.** It must state that the actor runs without cookies or a personal LinkedIn account;
the decision cannot be inherited silently from another board. `seek-search.ts` records SEEK's
equivalent as an explicit product decision rather than a technical default, and LinkedIn is a
stronger version of the same question.

**Check the URLs before believing anything else in this ticket.** That the actor yields a
canonical per-posting LinkedIn URL is an assumption read off its Apify listing, not a
measurement, and `postingId` and all of 02's grouping rest on it. Scope LinkedIn's tracking
parameters to LinkedIn's hosts on its descriptor, as 01 did for Indeed — never by appending
names to the global `TRACKING_PARAMETERS` set.

**`OVERVIEW.md` is this ticket's to fix.** Its "Not built yet" section lists "Several scouts,
merged and ranked", which this work closes — and closes differently from how it is drawn. The
fan-out is not several Scouts; it is one Scout ranking a pool that several boards fed. Update
the prose and the diagram node together.

**Blocked by:** 02 — Collapse a posting found on two boards. Landing LinkedIn before grouping
exists would put a third copy of the same advertisement in every brief.

**Status:** ready-for-agent

- [ ] The URLs the actor returns are canonical per-posting LinkedIn URLs, confirmed against a
      real run
- [ ] The LinkedIn board returns currently-open postings, each with its canonical URL, its
      listing date and the advertisement's own description
- [ ] Its request shape matches the other two boards'; the URL building is internal and tested
      directly, including the recency and employment-type translations
- [ ] Failure posture matches SEEK's and Indeed's — a rejected token throws, everything else
      comes back as a failure this one request can be continued past
- [ ] The docblock states the terms position explicitly, as `seek-search.ts` does for SEEK,
      including that no personal LinkedIn account authenticates the requests
- [ ] LinkedIn provenance parameters are dropped for LinkedIn's hosts only, verified against
      URLs the actor actually returned
- [ ] Existing cross-board grouping collapses an advertisement listed on all three boards into
      one Posting with two entries in `alsoOn`
- [ ] `OVERVIEW.md`'s "Not built yet" entry for scout fan-out is closed — prose and diagram
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**Not in this ticket:** raising the Scout's model-call ceiling, and measuring a three-board run.
The first stopped being a per-board concern when 05 took searching away from the Scout; the
second is 06.
