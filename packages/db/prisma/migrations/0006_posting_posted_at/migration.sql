-- When the advertisement said the role was posted, as a column the table can
-- order by.
--
-- The value already existed — `postings.payload` has carried `postedAt` since
-- `0005`, because the payload is the validated Posting verbatim — but it lived
-- inside the JSON as whatever free text the scout copied off the page. That is
-- displayable and not orderable: `ORDER BY` needs something to name, and a
-- string that might read "3 days ago" is not a date whatever it is stored as.
-- So the column is the projection and the payload stays the record, exactly as
-- `title`, `company`, `location` and `url` already are.
--
-- **Nullable, and NULL is not a defect.** The scout is instructed to omit the
-- field rather than estimate it, so an advertisement that did not state a date
-- produces no value at all — and one that stated it in prose produces a value
-- that is not a date. Both are ordinary. The dashboard orders this column NULLS
-- LAST in *both* directions for that reason: an unstated date is unknown, not
-- old, and it belongs at the bottom whichever way the column runs.
--
-- Forward-only, like every migration here.
--
-- **Unlike `0005`, this one backfills, and it can.** That migration created its
-- table empty because `posting_id` is a SHA-256 of a normalised URL and the only
-- implementation of those rules is `postingId()` in `@workspace/agents` — SQL
-- could not have reproduced it. A date is a cast, so every row already stored
-- comes along here for free and CI applies it on merge.
--
-- ⚠️ **The regex is half of a rule stated twice.** It is what decides which
-- stored strings are dates, and `parsePostedAt()` in
-- `apps/briefing-worker/src/postings.ts` enforces the same shape on the write
-- path. The two must agree: a row this statement skips and the worker would
-- accept, or the reverse, means the same advertisement sorts differently
-- depending on whether it was backfilled or re-found.
--
-- **It is not merely a filter, and a bare cast would be wrong even ignoring
-- errors.** Postgres accepts `'yesterday'`, `'today'`, `'now'` and `'infinity'`
-- as timestamp literals, so `("payload"->>'postedAt')::timestamptz` would
-- silently turn an advertisement that said "Yesterday" into a stamp taken from
-- whenever this migration happened to run — a fabricated date in a sortable
-- column, which is the one outcome the scout's "omit rather than estimate"
-- instruction exists to prevent. An ISO-8601 prefix is what SEEK's
-- `publishDateISO` produces and what the scout passes through, and it is the
-- only shape either side accepts. A space between the date and the time is
-- refused by both for a further reason: Postgres would read that form in the
-- database's zone and `new Date` in the machine's, so it is the one shape the
-- two rules could not agree on.
--
-- **The cast still goes through a trapping wrapper, because the regex admits
-- dates that do not exist.** `2026-02-30` is ISO-shaped and uncastable, and
-- Postgres has no `try_cast` — one such row anywhere in the table would abort
-- the whole statement and fail the deploy for every other row. The function is
-- created in `pg_temp`, so it is scoped to this migration's own session and
-- there is nothing left behind to drop.
--
-- **No index.** `0005` already sets the rule — one sort index only, because the
-- row count is bounded by what a single person's briefings found and title and
-- company order without one. This order is additionally NULLS LAST, which a
-- Prisma `@@index` cannot express, so an index declared for it would not serve
-- the query and would only be schema drift.

ALTER TABLE "postings" ADD COLUMN "posted_at" TIMESTAMPTZ(6);

CREATE FUNCTION pg_temp.try_timestamptz(value text) RETURNS timestamptz AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

UPDATE "postings"
SET "posted_at" = pg_temp.try_timestamptz("payload"->>'postedAt')
WHERE "payload"->>'postedAt' ~ '^\d{4}-\d{2}-\d{2}(T|$)';
