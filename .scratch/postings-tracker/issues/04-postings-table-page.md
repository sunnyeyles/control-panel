# 04 — The Briefings page becomes a sortable, paginated postings table

**What to build:** The page becomes a table of every Posting the user's
Briefings have ever found — one row per advertisement, sortable, paginated —
replacing the nested cards that showed only the most recent Run of each
Briefing.

This is the change the whole feature is for. Today a Posting the next Run does
not re-find simply vanishes; after this the page has a memory.

Sort and page belong in the query string, so a view survives a reload and can be
shared. This is the first thing in the app to read one, so treat it as untrusted
input with no form around it: a nonsense value degrades to a sensible default
rather than erroring.

Schedules and search criteria are still configured in Settings — this page does
not gain any of that.

**Blocked by:** 01 — The postings table and its store helpers.
_(Content needs 02 or 03 to have landed for the table to show anything, but the
work does not depend on them.)_

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Every Posting appears exactly once, however many Runs found it, across all
      of the user's Briefings.
- [ ] Each sortable column sorts in both directions, and the current sort is
      reflected in the URL.
- [ ] Pages navigate; the current page and the total are visible; a page number
      past the end lands on the last page rather than an empty one with working
      controls.
- [ ] No row appears on two pages, and none is skipped between them.
- [ ] A hand-edited or nonsense query string degrades to defaults rather than
      erroring — and a valid part of it survives beside an invalid part.
- [ ] Three empty states read distinctly: no Briefings at all, Briefings that
      have not yet run, and Runs that found nothing. Each says what to do next.
- [ ] The sidebar entry and the page heading both read **Postings**.
- [ ] Sorted columns announce their state to a screen reader.
- [ ] Only the user's own Postings are reachable, and a test asserts a second
      user's rows are not.
- [ ] Times are rendered identically on server and client — no hydration
      mismatch, and no time shown without its zone.
- [ ] The page still runs under `DEV_AUTH_BYPASS`, with enough fixture rows to
      reach a second page and to tell the sort orders apart.
- [ ] The Cover Letters section still lists, and still fails independently of
      the Postings query — one is Postgres and the other object storage, and an
      outage in either must not take the other down.
- [ ] **Running a briefing on demand, and seeing that one is running, both
      survive.** Each Briefing is still individually runnable, and still reports
      whether its last Run succeeded, failed or is in flight. A cumulative table
      has no per-Briefing row to carry that, so it moves above the table as a
      compact strip — one line per Briefing.
- [ ] The page still refreshes itself while a Run is in flight, and still stops
      doing so when none is — an idle tab must not poll.
- [ ] Run status fails independently of both the Postings query and the Cover
      Letters listing: three sources, three outcomes, no one of them able to
      blank the other two.
- [ ] The superseded card path and its read module are removed, not left
      orphaned — **after** everything living inside them has a new home. That
      component is also the only place the run controls and the letter controls
      are rendered, and nothing fails to compile when they disappear.
