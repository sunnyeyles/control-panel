# Multi-board search

Let the **Scout** search Indeed and LinkedIn as well as SEEK, so a **Briefing** covers the
boards a candidate actually reads rather than the one board we happened to build first.

`plan.md` holds the design, the options that were rejected, and the reasoning behind each
decision. The tickets below are vertical slices of it, in dependency order.

| #                                                         | Ticket                                 | Blocked by |
| --------------------------------------------------------- | -------------------------------------- | ---------- |
| [01](issues/01-search-indeed-alongside-seek.md)           | Search Indeed alongside SEEK           | —          |
| [05](issues/05-retrieve-postings-in-the-worker.md)        | Retrieve postings in the worker        | 01         |
| [02](issues/02-collapse-a-posting-found-on-two-boards.md) | Collapse a posting found on two boards | 05         |
| [03](issues/03-search-linkedin-alongside-the-others.md)   | Search LinkedIn alongside the others   | 02         |
| [06](issues/06-measure-what-retrieval-did.md)             | Measure what retrieval did             | 03         |
| [04](issues/04-sources-selects-the-boards-searched.md)    | `sources` selects the boards searched  | 03         |

**05 sits second on purpose, and that placement is this set's main correction.** It moves
retrieval out of the Scout and into the worker, which changes what a board integration _is_.
Ordered last, it would have had 01 and 03 each build a board as a tool the model calls and
then rebuilt both as adapters the worker calls — and it would have had 04 wire a filter, and
01 wire a per-board count, onto `SEARCH_TOOL_NAMES`, a mechanism it retires. Landing it while
there are two boards means one conversion instead of two, and it lets 02 group a retrieval
pool rather than group findings the model has already narrowed to eight.

**04 is not optional.** It was filed that way when `sources` was a field that looked like a
switch on a system with one board to switch between. 01 is what makes it actively wrong — a
Job naming `seek.com.au` starts receiving Indeed postings — so 01 carries an interim honesty
fix and 04 carries the real one.

## The property that must not be lost

`posting-id.ts` derives a **Posting**'s identity from its URL, on the stated grounds that
the URL is the one field guaranteed to have been _copied_ rather than composed — and its
docblock records the governing trade-off in as many words: _merging two distinct postings
is a far worse error than failing to merge one posting with itself._

Ticket 02 adds cross-board grouping, which is the first thing in this repo that could
violate that. It does not change how identity is derived. It groups **above** the id, only
across _different_ boards, and refuses to group at all when the match is ambiguous. If a
change to 02 ever makes it collapse two genuinely separate openings into one, the trade-off
has been inverted and the ticket is wrong, however much tidier the brief looks.

## The word this set does not use

**A retrieved advertisement is a Posting, not a "candidate".** `CONTEXT.md` spends the word
_candidate_ on the job seeker throughout — the candidate's voice, the candidate's CV, what a
candidate is looking for — and borrowing it for a search result is the same mistake as
borrowing _job_ for an employment opportunity. 05 and 06 say **retrieved Posting** and
**retrieval pool**; what the Scout selects out of that pool is **Findings**, which is already
a term. _Listing_ is out too — `CONTEXT.md` lists it under **Posting**'s _Avoid_. No fourth
word is introduced.

## Ordering, and two temporary regressions

01 lands Indeed before 02 lands grouping, so **between 01 and 02 a brief can show the same
posting twice** — once from each board. That is deliberate: grouping cannot be built or
tested until something produces duplicates. It is a known, bounded, visible state, not a
bug to be discovered later.

01 also lands a second board before 04 makes `sources` mean anything, so **between 01 and 04
a Job naming one board is searched on all of them**. 01 makes that visible in the field's own
description rather than leaving a config field quietly lying.

Say both on 01's pull request, and do not leave 02 and 04 long behind.
