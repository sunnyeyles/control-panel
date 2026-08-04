# Postings tracker

Rework the Briefings page from nested cards showing one Run's Postings into a
cumulative, sortable, paginated table where each Posting carries a status the
user sets.

`plan.md` beside this file carries the reasoning, the schema, and the file-level
detail. The tickets carry behaviour and acceptance criteria, and deliberately
name no file paths — those go stale, the plan does not.

## Tickets, in dependency order

| #   | Ticket                                                                                              | Blocked by     |
| --- | --------------------------------------------------------------------------------------------------- | -------------- |
| 01  | [The postings table and its store helpers](issues/01-postings-table-and-store-helpers.md)           | —              |
| 02  | [The worker records postings on every run](issues/02-worker-records-postings.md)                    | 01             |
| 03  | [Backfill existing findings into the postings record](issues/03-backfill-existing-findings.md)      | 01, 02         |
| 04  | [The Briefings page becomes a sortable, paginated postings table](issues/04-postings-table-page.md) | 01             |
| 05  | [Set a Posting's status from the table](issues/05-set-posting-status.md)                            | 04             |
| 06  | [Posting detail dialog](issues/06-posting-detail-dialog.md)                                         | 04             |
| 07  | [Draft Cover Letters from the stored Posting](issues/07-draft-letters-from-stored-posting.md)       | 06             |
| 08  | [Glossary, overview and conventions](issues/08-glossary-and-conventions.md)                         | 04, 05, 06, 07 |

```
01 ─┬─ 02 ── 03
    │
    └─ 04 ─┬─ 05 ─────────┐
           ├─ 06 ── 07 ───┼─ 08
           └──────────────┘
```

After 04 lands, 05 and 06 can proceed in parallel.

## Ship order

01–03 merge and deploy on their own: the worker fills the record while nothing
reads it. **Then run the backfill.** Only then deploy 04 onward, so the page
never reads a table the worker has not filled — deploying the dashboard first
shows every user an empty tracker.

```
migrate  →  backfill  →  deploy dashboard
```

## Two things not to undo

- **The upsert's update list omits the status column, and that omission is the
  feature.** Adding it back "for symmetry" silently destroys the only data in
  the table a person entered. Ticket 01 spells it out.
- **Identity is `(user, Posting)` with no Run in it.** The Run is provenance.
  This is the same unit of identity a stored Cover Letter is keyed on, which is
  why the two agree without coordination.

## Settled since drafting

These tickets were written against `ecd3c5b`; `plan.md` §Drift lists everything
that landed after. Two of those changes needed a decision rather than a
rewording, and both are folded into existing tickets because each is a re-home
rather than a feature:

- **Running a briefing on demand outlives the cards.** #119 put a Run-now button
  and a run-status line on each Briefing card — the component ticket 04 removes,
  and the only place either is rendered. They move to a **compact strip above
  the table**, one line per Briefing, both controls reused unchanged. → 04
- **So does editing a cover letter.** #123 put an edit button on the Posting
  card beside drafting and downloading; the letters listing offers downloads
  only. All three move into the dialog together. → 06

## Open questions, carried from the plan

- The sidebar will say **Postings** while the URL stays `/briefings`. Renaming
  the segment is mechanical but touches trace metadata and prose in three docs,
  so it was left as a follow-up rather than folded in.
- `status_changed_at` is the one column nobody asked for. A tracker that cannot
  say when you applied is half a tracker, and adding it later is another
  migration — but it is the first thing to cut if 01 needs trimming.
