# Multi-board search

Let the **Scout** search Indeed and LinkedIn as well as SEEK, so a **Briefing** covers the
boards a candidate actually reads rather than the one board we happened to build first.

`plan.md` holds the design, the options that were rejected, and the reasoning behind each
decision. The tickets below are vertical slices of it, in dependency order.

| #                                                         | Ticket                                 | Blocked by |
| --------------------------------------------------------- | -------------------------------------- | ---------- |
| [01](issues/01-search-indeed-alongside-seek.md)           | Search Indeed alongside SEEK           | —          |
| [02](issues/02-collapse-a-posting-found-on-two-boards.md) | Collapse a posting found on two boards | 01         |
| [03](issues/03-search-linkedin-alongside-the-others.md)   | Search LinkedIn alongside the others   | 02         |
| [05](issues/05-make-scout-retrieval-measurable.md)        | Make Scout retrieval measurable        | 03         |
| [04](issues/04-sources-selects-the-boards-searched.md)    | `sources` selects the boards searched  | 03         |

04 is optional and does not block anything. It exists because `sources` is currently a config
field that looks like it selects boards and selects nothing. 05 establishes the retrieval
baseline before adding more source choices.

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

## Ordering, and one temporary regression

01 lands Indeed before 02 lands grouping, so **between 01 and 02 a brief can show the same
posting twice** — once from each board. That is deliberate: grouping cannot be built or
tested until something produces duplicates. It is a known, bounded, visible state, not a
bug to be discovered later. Do not merge 01 to production without 02 close behind, and say
so on 01's pull request.
