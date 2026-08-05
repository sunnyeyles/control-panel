# Rough plan — more job boards

Goal: the Scout looks at Indeed and LinkedIn as well as SEEK.

## Order

**1. Fix the tracking-parameter thing first.**

`normalisePostingUrl` in `packages/agents/src/posting-id.ts` strips `utm_*` and nine named
parameters. That's right for SEEK and not enough for LinkedIn, whose URLs carry per-search
`refId` and `trackingId` — see `linkedin-tool.md`, it's a real bug that loses people's
`applied` status.

Needs a per-board set of parameters scoped to that board's hosts, not more names in the
global list. Small change, blocks both tools, do it first.

**2. Pull the shared Apify plumbing out of `seek-search.ts`.**

Before writing a second board, look at what's actually SEEK-specific in that file. Not
much — the actor id, the request body mapping, the result interface, the field names in
the formatter. The other ~280 lines (token handling, the timeout, description truncation,
the failure split, result formatting) are the same for any Apify actor.

Same story in the tests: of the 21 cases in `seek-search.test.ts`, ~15 are plumbing
behaviour that's identical for every board.

So: one shared module, three thin board configs. Otherwise we copy 700 lines twice.

We now know what all three boards need, so this isn't a guess.

**3. Indeed** — see `indeed-tool.md`.

**4. LinkedIn** — see `linkedin-tool.md`. Independent of Indeed; either order.

**5. Stop and actually use it.**

## Then see what's actually a problem

Deliberately not building these yet:

**Duplicate postings.** A role listed on two boards will show up twice. Might be annoying,
might be rare. Grouping them properly is fiddly — you have to match on company + title +
city, only across different boards, and refuse to group when it's ambiguous, because
merging two genuinely different openings is much worse than showing one twice. Not worth
building until we've seen how often it actually happens.

**`sources` in the job config.** It looks like a switch for picking boards and it doesn't
do anything. Currently harmless because there's one board; the moment Indeed lands, a Job
saying `seek.com.au` starts getting Indeed results. Either wire it up or delete the field
— but at minimum change its description so it stops lying.

**Context blowing up.** A sweep is `titles × locations × boards` searches now. Indeed
alone is 77 KB per 6 results. Three titles × two locations × three boards is eighteen
searches and probably over a megabyte before the Scout has thought about any of it. Might
be fine with low per-search result counts. If it isn't, the fix is fewer results per
search, not a bigger model-call budget — a bigger budget just buys more searches and more
context.

**Moving retrieval into the worker.** The bigger idea: the worker plans and runs the
searches, the Scout just ranks what it's handed. Solves coverage (nothing gets silently
skipped) and context (the worker bounds the pool). But it's a pipeline rewrite and nothing
here needs it yet. Revisit if the Scout starts skipping criteria or running out of budget.

## Docs that go stale

- `OVERVIEW.md` "Not built yet" lists "Several scouts, merged and ranked" — this is that,
  sort of. It's one Scout reading several boards, not several Scouts.
- `run-briefing.ts`'s docblock says the fan-out leaves everything downstream alone. True
  for now, false if we ever do the worker-retrieval thing.

## Reference

Both actors were run live on 2026-08-05, ~$0.09 total. Field names, request bodies, costs
and the id-stability results in the two tool docs are measured, not from the listings.
