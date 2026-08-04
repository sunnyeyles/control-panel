# 01 — The postings table and its store helpers

**What to build:** Postgres gains a record of every Posting a user's Briefings
have found, keyed on `(user, Posting)` so the same advertisement found by two
Runs a week apart is one row rather than two. Each record carries a status —
`new`, `applied` or `rejected` — that a Run may never overwrite, plus the Runs
that first and most recently reported it as provenance.

Identity comes from the existing derived Posting id, not a new scheme: it is
already what a stored Cover Letter is keyed on, so the two agree by
construction.

This ticket ships no user-visible change. It is the foundation the rest sit on,
and it can merge and deploy on its own.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## The decision this ticket exists to protect

From the plan. The upsert's update list is the whole feature, and it is
silently undoable — a reviewer adding `status` "for symmetry" would destroy the
only data in this table a person entered:

```sql
ON CONFLICT (user_id, posting_id) DO UPDATE SET
  title = EXCLUDED.title, company = EXCLUDED.company,
  location = EXCLUDED.location, url = EXCLUDED.url,
  payload = EXCLUDED.payload,
  last_seen_at = EXCLUDED.last_seen_at,
  last_seen_run_id = EXCLUDED.last_seen_run_id
WHERE EXCLUDED.last_seen_at >= postings.last_seen_at
```

`status`, the time it changed, and both first-seen values are absent on
purpose. The trailing `WHERE` makes the write order-independent, so the backfill
can walk Runs oldest-first beside live traffic without dragging the last-seen
values backwards.

## Acceptance criteria

- [ ] A Posting recorded twice for the same user updates one row rather than
      inserting a second.
- [ ] **A status set to `applied` survives a later Run re-recording that
      Posting.** This is the ticket's whole point and needs its own test.
- [ ] A second sighting leaves the first-seen time and first-seen Run unchanged,
      and advances the last-seen time and last-seen Run.
- [ ] A record carrying an _older_ sighting time moves neither last-seen value
      backwards.
- [ ] Two Postings in one batch that normalise to the same identity do not
      error, and produce one row. (Postgres refuses to let one statement affect
      a row twice; merging an advertisement found twice with different tracking
      parameters is the ordinary case, not an edge one.)
- [ ] The database refuses a status outside the three, and refuses an identity
      that is not the shape the derived Posting id takes — it is also an object
      key segment, so a malformed one must not be storable.
- [ ] Changing the status of a Posting belonging to another user reports no
      match and alters nothing.
- [ ] Deleting a Run that a Posting references fails, matching the schema's
      existing restrict-never-cascade posture.
- [ ] All of the above are covered in the store suite that runs against a real
      database, since every one is a property of the database rather than of the
      code.
- [ ] The new store file is listed in the database package's seam table, and the
      update-list rule is recorded in its schema notes.
