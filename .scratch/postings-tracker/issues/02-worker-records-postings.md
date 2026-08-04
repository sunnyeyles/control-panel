# 02 — The worker records postings on every run

**What to build:** A briefing run adds what its scout found to the cumulative
record, so a Posting outlives both the Run that found it and the Findings that
the next Run overwrites.

The write is an accessory to the run, not part of it: a run that produced a
Brief succeeded whatever happened to this record, exactly as the existing
Findings write already behaves.

Still no user-visible change — the record fills up while nothing reads it. This
and the ticket before it can deploy together, ahead of any dashboard work.

**Blocked by:** 01 — The postings table and its store helpers

**Status:** ready-for-agent

## Acceptance criteria

- [ ] After a briefing run, every Posting its scout reported appears in the
      cumulative record, attributed to that Run.
- [ ] Running the same briefing again updates those records rather than
      duplicating them, and leaves any status a user has set alone.
- [ ] A failure to record postings leaves the run **succeeded**, carrying a
      warning — matching how a failed Findings write behaves today. It must not
      fail a run that produced a Brief.
- [ ] The sighting time is the run's scheduled occurrence rather than the wall
      clock, so a run starting before midnight and finishing after it does not
      claim it found something the following day.
- [ ] The step is visible in the run's trace beside the Findings step, reporting
      how many Postings it recorded or why it did not.
- [ ] The local dry-run harness still runs end to end with no database.
- [ ] Worker tests cover both the success path and the non-fatal failure path.
