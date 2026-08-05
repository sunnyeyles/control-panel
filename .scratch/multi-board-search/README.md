# Multi-board search

Let the **Scout** search Indeed and LinkedIn as well as SEEK, so a **Briefing** covers
the boards a candidate actually reads rather than the one board we happened to build
first.

`plan.md` holds the design, the live measurements both actors were checked against, and
the options that were rejected. The tickets below are vertical slices of it.

| #                                                         | Ticket                                 | Blocked by | Size |
| --------------------------------------------------------- | -------------------------------------- | ---------- | ---- |
| [00](issues/00-scope-tracking-parameters-per-board.md)    | Scope tracking parameters per board    | —          | S    |
| [01](issues/01-search-indeed-alongside-seek.md)           | Search Indeed alongside SEEK           | 00         | M    |
| [02](issues/02-search-linkedin-alongside-the-others.md)   | Search LinkedIn alongside the others   | 00         | M    |
| [03](issues/03-collapse-a-posting-found-on-two-boards.md) | Collapse a posting found on two boards | 01 or 02   | M    |
| [04](issues/04-sources-selects-the-boards-searched.md)    | `sources` selects the boards searched  | 01         | S    |
| [05](issues/05-retrieve-postings-in-the-worker.md)        | Retrieve postings in the worker        | 01         | L    |
| [06](issues/06-measure-what-retrieval-did.md)             | Measure what retrieval did             | 03         | S    |

**01 and 02 are independent of each other** — both need only 00, and each is a board
built to the shape `seek-search.ts` already establishes. Run them in parallel.

**00 is a bug fix wearing a ticket's clothes, and nothing ships before it.** LinkedIn's
URLs carry per-search tracking parameters that reach `postingId`; measured, two runs
twenty seconds apart agreed on **zero of nine** ids. Ship LinkedIn without it and every
run re-mints every posting, losing the `status` a person set. It is a small change to
one file and it unblocks both boards.

**05 is off the critical path, and that is this revision's main correction.** It was
sequenced second on the grounds that a board is a different artifact either side of it —
a tool the model calls, then an adapter the worker calls — so the boards would be built
twice. The cheaper answer is for each board to export a **typed function** with a thin
`tool()` wrapper on top, which is what `seek-search.ts` already does. Then 05 changes who
calls the function and deletes the wrapper, and no ticket waits on a pipeline rewrite to
ship a board.

## The property that must not be lost

`posting-id.ts` derives a **Posting**'s identity from its URL, and its docblock records
the governing trade-off in as many words: _merging two distinct postings is a far worse
error than failing to merge one posting with itself._

Ticket 03 adds cross-board grouping, the first thing here that could violate it. It does
not change how identity is derived — it groups **above** the id, only across _different_
boards, and refuses to group when the match is ambiguous. If a change to 03 ever
collapses two genuinely separate openings into one, the trade-off has been inverted and
the ticket is wrong, however much tidier the brief looks.

## The word this set does not use

**A retrieved advertisement is a Posting, not a "candidate".** `CONTEXT.md` spends
_candidate_ on the job seeker throughout, and borrowing it for a search result is the
same mistake as borrowing _job_ for an employment opportunity. Say **retrieved Posting**
and **retrieval pool**; what the Scout selects out of that pool is **Findings**, which is
already a term. _Listing_ is out too — `CONTEXT.md` has it under **Posting**'s _Avoid_.

## Two temporary regressions

01 and 02 land boards before 03 lands grouping, so **a brief can show the same posting
once per board**. Deliberate: grouping cannot be tested until something produces
duplicates.

01 also lands a second board before 04 makes `sources` mean anything, so **a Job naming
one board is searched on all of them**. 01 makes that visible in the field's own
description rather than leaving a config field quietly lying.

Say both on the pull requests, and do not leave 03 and 04 long behind.
