# Answering "does a cover letter exist" without asking S3 per posting

**Status:** not started. Written alongside the postings-table refactor that made
the cost visible but deliberately did not remove it.

The postings table shows, per row, whether a cover letter has already been
drafted. Answering that for one page of the table currently costs one S3
`HeadObject` request per posting — twenty-five of them, every time the page
renders. This describes why, why the streaming change did not fix it, and what
actually would.

## The current path

`apps/dashboard/app/(app)/briefings/page.tsx` hands the visible postings' ids to
`loadCoverLetterRows` in `apps/dashboard/lib/cover-letters/cover-letter-rows.ts`,
which fans out over them:

```
page.tsx
  └─ loadCoverLetterRows(userId, postingIds, letters)
       └─ settleWithConcurrency(postingIds, HEAD_CONCURRENCY = 8, …)
            └─ letters.head({ userId, postingId })     ← one S3 HeadObject each
```

`PAGE_SIZE` is 25 and `HEAD_CONCURRENCY` is 8, so a page render is 25 requests in
roughly four sequential waves. A missing object throws `object_not_found`, which
is caught and read as the ordinary undrafted state; anything else rejects the
whole batch, because a page that silently reported "no letter" for a store it
could not reach would be lying to someone who had already written one.

**There is no cheaper question available today.** `CoverLetterStore` exposes
`put`, `get`, `head` and `delete` and nothing that answers a set. A letter's
address is derivable — `{environment}/{userId}/cover-letters/{postingId}.md` —
so `head()` is the only way to turn a posting id into a yes or no, and twenty-five
postings means twenty-five of them.

**This is not once per visit.** It is once per _render_: every sort click, every
page click, and every poll while a briefing is running —
`refresh-while-running.tsx` refreshes the route every 5 seconds for up to 15
minutes. An open tab watching a run therefore issues about 300 `HeadObject`
requests a minute, all to redraw a column of icons that almost never changes.

## Why streaming was not the fix

The refactor moved these reads off the critical path. `page.tsx` no longer awaits
them; the promise is passed down and read by a per-row `<Suspense>` boundary in
`cover-letter-cell.tsx`, so the table paints immediately and the letter column
fills in behind skeletons.

That is a real improvement to how the page _feels_, and it changes nothing about
what the page _does_. All twenty-five requests are still issued, still billed,
still counted against `maxDuration`, and still fail as a unit. The work is now
concurrent with the render instead of in front of it — which is the definition of
hiding a cost, not removing one.

It also does not scale. The wait is hidden as long as the letter column resolves
before anyone looks at it; raise `PAGE_SIZE` and the number of waves rises with
it, and the skeletons become something users watch rather than something they
miss.

## The fix: record existence when a letter is written

The question "does this posting have a letter" is answered today by asking the
store. It should be answered by the row the table has already fetched.

A nullable `cover_letter_drafted_at timestamptz` on `postings` is the smallest
version. That table's natural key is `(user_id, posting_id)`, which is exactly a
letter's address, so this needs no new table and no join — one more column in the
`select` that `listPostings` already issues. Cost per page render drops from 25
S3 requests to zero.

The writers are the three `put()` call sites in
`apps/dashboard/lib/cover-letters/cover-letter-actions.ts` — drafting, creating
by hand, and saving an edit — plus any delete path, which would have to null the
column back out.

### What makes it more than a migration

**⚠️ There is an existing decision to engage with first.** `CoverLetterStore` in
`packages/user-storage/src/cover-letter-store.ts` says a letter has no database
row _deliberately_: `artifacts.run_id` is `NOT NULL`, drafting is not an
execution of a briefing, and minting an ad-hoc run per click would put
non-briefing rows in a job's history. That argument is about **addressability**,
and it still holds — a letter's key is derivable and a row buys nothing there.
This proposal is about **enumerability**, which is a different question the
original reasoning did not consider: not "where is this letter" but "which of
these twenty-five have one". A column on `postings` is also not an `artifacts`
row, so the `run_id` objection does not reach it.

**S3 and Postgres share no transaction, so the column can lie in both
directions.** Whichever write goes second can fail on its own:

- **Letter written, column not set** — the row says "none". The user is offered
  _Draft a cover letter_ for a posting that already has one, and taking that
  offer spends a model call and overwrites their edited draft. Partly survivable:
  the bucket is versioned with a noncurrent-expiry rule, so the overwritten draft
  exists as a non-current version for as long as that rule allows.
- **Column set, letter not written** — the row says "drafted". Download and Edit
  both fail, because `/api/cover-letters/[postingId]` has nothing to serve.

Neither is catastrophic and both need a decided answer rather than an assumed
one. Writing S3 first and Postgres second makes the first case the common one,
which is the one the version history partly covers.

**The column is a cache, so it needs a way to heal.** The detail panel already
talks to the store when a user acts on a letter, which is the natural place to
notice a mismatch and correct the row.

**Existing letters have no column value, and a migration cannot read S3.** Either
a one-off backfill enumerates the bucket per user, or `NULL` has to mean _unknown_
rather than _none_ and fall back to `head()` — which keeps the current cost alive
for every row written before the change. The backfill is the honest option, and
it is a second piece of work rather than part of the migration.

## A cheaper alternative, if the schema change is unwelcome

`UserObjectStore` already exposes `list(userId, kind)`, and the last segment of a
cover letter's key **is** the posting id —
`packages/user-storage/src/cover-letter-store.ts` already parses it back out when
building a `StoredCoverLetter`. So one `ListObjectsV2` per page render returns
every letter that user has, and the set of drafted posting ids falls out of the
keys.

That is 1 round trip instead of 25, with no migration, no second writer to keep
in step, and no consistency question — the store stays the single source of
truth. Two caveats:

- **`CoverLetterStore` has no `list()`**, only the object store beneath it. The
  facade would need one, which is where the existing key-parsing helper would
  move.
- **A listing returns less metadata than `head()`.** Existence and `draftedAt`
  (from `LastModified`) come back; the provenance the detail panel renders —
  `displayName`, `filename` — does not, because those live in object metadata.
  That is fine for the shape the table now has: the compact row needs only
  existence, and the expanded detail concerns exactly one posting, so it can
  `head()` its own.
- It stays **O(letters a user has)** rather than O(page), so it degrades slowly
  for a heavy user where the column does not.

**This is probably the better first move.** It removes 24 of every 25 requests
for a fraction of the work and none of the consistency risk, and it does not
foreclose the column later.

## Verifying either one

- Sort the table and count `HeadObject` calls — the current path issues 25, the
  column issues 0, the listing issues 1.
- Leave a briefing running with the table open and confirm the 5-second poll no
  longer multiplies that count.
- Draft a letter, then reload: the row must show it. Draft a letter with the
  second write forced to fail, and confirm the resulting state is the one this
  document says it should be, rather than a crash.
- Confirm a storage failure still renders the page-level alert and **not**
  twenty-five rows claiming "no letter" — that distinction is the reason
  `loadCoverLetterRows` rejects rather than degrades, and it is easy to lose
  while changing the read path.
