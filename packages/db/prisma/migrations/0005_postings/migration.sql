-- Every Posting a user's briefings have ever found, one row per
-- (user, Posting) however many Runs reported it.
--
-- `runs.findings` cannot hold this. Each Run writes its own findings and the
-- dashboard reads only the newest, so a status stored there is erased or
-- orphaned by the next Run — and a Posting the next Run does not re-find simply
-- vanishes. This table is the cumulative record; findings stay what one Run
-- reported, and the two are not redundant.
--
-- Identity is `(user_id, posting_id)` with **no Run in it**, the precedent
-- `packages/user-storage/src/cover-letter-store.ts` already set for cover
-- letters: the same advertisement found by two Runs a week apart is one thing.
-- Runs are provenance, and they are recorded as first/last seen values rather
-- than as part of the key.
--
-- Forward-only, like every migration here.
--
-- **The table is created empty, and no SQL backfill is possible.** `posting_id`
-- is a SHA-256 of a *normalised* URL — tracking parameters dropped, the
-- survivors sorted, a default port removed, a trailing slash stripped — and the
-- only implementation of those rules is `postingId()` in `@workspace/agents`. A
-- reimplementation in SQL that disagreed by one rule would mint ids nothing
-- else in the system agrees with, silently orphaning every stored cover letter
-- for the postings it touched. SEEK stamps `?ref=` on its links, so URLs
-- differing only in tracking parameters are the ordinary case here, not an edge
-- one. Historic Runs are loaded by a script that calls that same function,
-- which is what makes normalisation identical by construction.

-- CreateTable
CREATE TABLE "postings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    -- The *derived* Posting id from `postingId()`, not this row's `id`. Also an
    -- S3 key segment: a drafted letter lives at
    -- `…/cover-letters/{posting_id}.md`, which is why the CHECK below matters.
    "posting_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    -- The validated Posting as its producer wrote it. Opaque here, exactly as
    -- `runs.findings` and `jobs.config` are. The four columns above are the
    -- projection this table sorts and displays on; one statement writes both,
    -- so they cannot drift.
    "payload" JSONB NOT NULL,
    -- text + CHECK rather than a Postgres enum, as `runs.status` is. The only
    -- column in this schema a *person* writes.
    "status" TEXT NOT NULL DEFAULT 'new',
    -- NULL means nobody has ever moved it off `new`.
    "status_changed_at" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_seen_run_id" UUID NOT NULL,
    "last_seen_run_id" UUID NOT NULL,

    CONSTRAINT "postings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "postings_status_check"
      CHECK ("status" IN ('new', 'applied', 'rejected')),
    -- Sixteen lowercase hex characters, the shape `postingId()` produces. Not a
    -- duplicate of the validation in
    -- `apps/dashboard/lib/cover-letters/cover-letter-ref.ts`: that rule guards
    -- *untrusted input* and stays the only copy of that. This one says the
    -- database must not hold a value that cannot be an object key segment,
    -- exactly as `artifacts_object_key_check` refuses a URL.
    CONSTRAINT "postings_posting_id_check"
      CHECK ("posting_id" ~ '^[0-9a-f]{16}$'),
    CONSTRAINT "postings_seen_order_check"
      CHECK ("last_seen_at" >= "first_seen_at")
);

-- Restrict, never cascade, per `0001_init`. A Posting names the Runs that found
-- it, so deleting one of those Runs should fail loudly rather than silently
-- erase the provenance. `cover_letter_instructions` remains the single
-- exception in this schema, and it earns it by recording no provenance at all.
ALTER TABLE "postings"
  ADD CONSTRAINT "postings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "postings"
  ADD CONSTRAINT "postings_first_seen_run_id_fkey"
  FOREIGN KEY ("first_seen_run_id") REFERENCES "runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "postings"
  ADD CONSTRAINT "postings_last_seen_run_id_fkey"
  FOREIGN KEY ("last_seen_run_id") REFERENCES "runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The unit of identity, and the ON CONFLICT target `recordPostings` names.
CREATE UNIQUE INDEX "postings_user_id_posting_id_key"
  ON "postings" ("user_id", "posting_id");

-- The default listing, tie-broken so a page boundary cannot show one row twice.
-- One sort index only, deliberately: title and company order is sorted without
-- one, and the row count is bounded by what a single person's briefings found.
-- Four indexes to avoid sorting a few hundred rows would be four more things to
-- keep correct for no gain.
CREATE INDEX "postings_user_last_seen_idx"
  ON "postings" ("user_id", "last_seen_at" DESC, "posting_id" DESC);
