# 03 — Backfill existing findings into the postings record

**What to build:** Every Posting already sitting in a Run's Findings appears in
the cumulative record, with a first-seen time reflecting when it was actually
first found rather than when the backfill ran.

Without this, the moment the dashboard reads the new record instead of Findings,
every Posting a user has ever seen disappears — including ones they already have
a drafted Cover Letter for. That is silent data loss, and the data is right
there.

It is a script rather than part of the migration for a specific reason worth
keeping in the file: the Posting identity is a hash of a _normalised_ URL —
tracking parameters dropped, survivors sorted, default port removed, one
trailing slash stripped. A reimplementation of that in SQL disagreeing by a
single rule would mint identities nothing else in the system agrees with, and
the job board the scout searches stamps a tracking parameter on the URLs it
returns, so this is the ordinary case rather than a rare one.

**Blocked by:** 01 — The postings table and its store helpers; 02 — The worker
records postings on every run

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A one-off command populates the cumulative record from existing Findings.
- [ ] Runs are walked oldest first, and each Posting's first-seen time is the
      Run that found it, so the resulting times are truthful.
- [ ] Running it a second time changes nothing.
- [ ] Running it after a user has set statuses leaves every one of those
      statuses untouched.
- [ ] Runs whose Findings are absent or do not parse are skipped and counted,
      never fatal — a Run predating the Findings column is an ordinary state.
- [ ] Identity is derived by the same code the worker uses, never reimplemented,
      so the ids agree with Cover Letter keys already in storage.
- [ ] It reports what it did in one structured line: runs walked, skipped, and
      records written.
- [ ] The release ordering is documented — migrate, backfill, then deploy the
      dashboard. Deploying the dashboard first shows every user an empty
      tracker.
