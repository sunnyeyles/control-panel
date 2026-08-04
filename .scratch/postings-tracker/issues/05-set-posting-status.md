# 05 — Set a Posting's status from the table

**What to build:** Each row shows where that application stands and lets the
user move it — `new`, `applied` or `rejected` — turning the table from a list of
search results into a record of what they have done about them.

**Blocked by:** 04 — The Briefings page becomes a sortable, paginated postings
table

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A status can be changed from the table and persists across a reload.
- [ ] **It survives the next briefing run re-finding that Posting.** The
      end-to-end proof of the feature: set a status, run the briefing again,
      confirm it is unchanged.
- [ ] The control shows the new value immediately and reverts if the change
      fails — the row did not change, so the control must not pretend it did.
- [ ] A failure is reported beside the row that failed, not as a page-level
      banner.
- [ ] Attempting to change a Posting belonging to someone else is refused, with
      one message that does not reveal whether it exists.
- [ ] A status outside the three is refused before anything is queried.
- [ ] The caller's identity is established before the submitted body is read at
      all, and is never taken from the submission.
- [ ] Each control is labelled with its Posting, so several on one page are
      distinguishable to a screen reader.
- [ ] Works under `DEV_AUTH_BYPASS`.
