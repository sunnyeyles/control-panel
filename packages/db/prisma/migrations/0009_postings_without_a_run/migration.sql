-- A Posting no longer arrives only from a Run.
--
-- Pasting a job advertisement's link adds a Posting the dashboard writes
-- directly, and there is no Run behind it to name: a Run is one execution of a
-- Job on a cadence, and minting a synthetic one to satisfy a foreign key would
-- put a row in `runs` that never ran.
--
-- So NULL, in both columns, means "no Run has ever seen this — the user added
-- it by link". That is the same idiom as `next_run_at IS NULL` for "not
-- scheduled" and `scheduled_for IS NULL` for "ad-hoc": the fact is derivable
-- from a column the row already carries, so there is no `source` column and
-- there must not be one — see `apps/dashboard/lib/postings/posting-source.ts`,
-- which makes the same argument about `url`.
--
-- The two columns move independently and that is deliberate. A Run that later
-- finds a link-added advertisement sets `last_seen_run_id` and leaves
-- `first_seen_run_id` NULL, because a second sighting cannot change who saw it
-- first — which reads, correctly, as "you found this one yourself".
--
-- Widening only. Every existing row names a Run and keeps doing so.

ALTER TABLE "postings" ALTER COLUMN "first_seen_run_id" DROP NOT NULL;
ALTER TABLE "postings" ALTER COLUMN "last_seen_run_id" DROP NOT NULL;
