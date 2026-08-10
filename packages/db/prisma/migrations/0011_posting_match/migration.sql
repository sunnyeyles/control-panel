-- How well an advertisement matches the person reading it.
--
-- `payload -> matchReason` already holds a sentence about the *criteria* a
-- scout was handed — titles, locations, keywords — and criteria are a lossy
-- projection of a person. These five columns hold the other judgement: the
-- advertisement weighed against the candidate's own resume, which is the thing
-- that answers whether to apply. A Posting somebody added by pasting a link has
-- these and no `matchReason` at all.
--
-- Columns rather than another key inside `payload`, for the reason the five
-- projected columns beside them exist: the table sorts and ranks on this. A
-- score buried in an opaque JSON blob is a score nobody can order a page by.
--
-- ⚠️ **Nothing in the pipeline may write these.** They join `status` as columns
-- a Run's `ON CONFLICT DO UPDATE` must leave alone — see the `DO UPDATE SET`
-- list in `recordPostings`, whose docblock now enumerates five load-bearing
-- absences rather than four. A Run re-finding a scored advertisement blanking
-- its score would be the same silent, scheduled data loss that omission has
-- always been about.
--
-- No backfill. A score is a model call against a document, so there is nothing
-- to derive one from in SQL — every existing row is simply unmatched, which is
-- exactly what NULL says.

ALTER TABLE "postings"
  ADD COLUMN "match_score"     SMALLINT,
  ADD COLUMN "match_reason"    TEXT,
  ADD COLUMN "match_gaps"      JSONB,
  ADD COLUMN "match_resume_id" UUID,
  ADD COLUMN "matched_at"      TIMESTAMPTZ(6);

-- The bound also lives in `PostingMatchSchema`, where a model's answer is
-- parsed. Two enforcements, deliberately: the column is written by a Server
-- Action, and a bound the database does not hold survives exactly as long as
-- every future caller remembers it.
ALTER TABLE "postings" ADD CONSTRAINT "postings_match_score_check"
  CHECK ("match_score" IS NULL OR "match_score" BETWEEN 0 AND 100);

-- All five or none. A half-written match is a score nobody can date or
-- attribute to a document — and `match_resume_id` is the whole of how staleness
-- is decided, so a row carrying a score without one would be permanently
-- un-rescorable.
ALTER TABLE "postings" ADD CONSTRAINT "postings_match_complete_check"
  CHECK (
    num_nonnulls(
      "match_score", "match_reason", "match_gaps", "match_resume_id", "matched_at"
    ) IN (0, 5)
  );

-- `match_resume_id` names the `documents.id` the score was computed against,
-- and is deliberately **not** a foreign key — the same argument the schema makes
-- for `users.auth_user_id`. `RESTRICT` would make a document undeletable the
-- moment anything scored against it, and `SET NULL` would break the
-- completeness check above. What it is for is one comparison: a value other
-- than the user's current resume means the score is for a document they have
-- replaced, and the row wants scoring again.

-- Ordering a page by fit. `NULLS LAST` in the index for the reason
-- `postings_user_last_seen_idx` carries its own direction: an unscored row is
-- not a badly-matched one, and Postgres would default `DESC` to NULLS FIRST and
-- put every row nobody has scored above every row somebody has. The
-- `posting_id` tie-break matches the one every other order carries, because
-- offset pagination over a non-unique key shows one row twice and skips
-- another.
CREATE INDEX "postings_user_match_idx"
  ON "postings" ("user_id", "match_score" DESC NULLS LAST, "posting_id" DESC);
