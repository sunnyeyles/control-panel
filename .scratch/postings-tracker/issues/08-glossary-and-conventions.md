# 08 — Glossary, overview and conventions

**What to build:** The project's shared vocabulary and architecture notes
describe the system as it now works. Several existing entries actively describe
the superseded behaviour, so this is a correction rather than an addition.

Each preceding ticket carries its own local commentary. What is left here is the
cross-cutting material no single ticket owns.

**Blocked by:** 04, 05, 06, 07

**Status:** ready-for-agent

## Acceptance criteria

- [ ] The glossary defines **Posting Status**: the three values, that discovery
      writes only the first, and that a Run must never overwrite the other two.
      Words to avoid are listed, as every entry does.
- [ ] The **Posting** entry records that a Posting is now also a stored record
      keyed on `(user, Posting)` — the same unit of identity a Cover Letter's
      object key already uses, and for the same reason.
- [ ] The **Findings** entry no longer claims the dashboard renders Postings out
      of it, and states plainly how Findings and the cumulative record differ:
      one is what a single Run reported, kept against that Run; the other is the
      record of the search across every Run. Neither replaces the other.
- [ ] The **Cover Letter** entry reflects where a draft's source text now comes
      from.
- [ ] The project overview's pipeline diagram includes the new write, and its
      "not built yet" list is accurate — the Brief viewer remains the item
      blocked on an access grant.
- [ ] The dashboard's conventions record how query-string state is validated,
      this being the first such consumer, including that it degrades rather than
      errors and that nothing in a query string may ever name a user.
- [ ] The database README records that removing the status column from the
      upsert's update list is silent data loss.
- [ ] The note insisting on a single copy of the Posting id shape names its
      deliberate database counterpart, so the rule is not violated by omission.
- [ ] No document still describes the page as showing only the latest Run's
      Postings.
