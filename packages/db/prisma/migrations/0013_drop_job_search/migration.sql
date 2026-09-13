-- The job search is gone, and so is everything it wrote.
--
-- The briefing worker, Postings, cover letters and tailored resumes were
-- removed from the codebase together, and these six tables had no reader left:
-- `jobs` and `runs` scheduled and recorded briefings, `artifacts` pointed at the
-- briefs those runs wrote, `postings` was the cumulative tracker, and
-- `posting_filters` and `cover_letter_instructions` were settings only the
-- search consulted. `users`, `documents` and `boards` are untouched.
--
-- Forward-only, like every migration here.
--
-- **Children first, and no CASCADE.** `artifacts` and `postings` reference
-- `runs`, and `runs` references `jobs`; Postgres refuses to drop a table another
-- still references, so the order is the foreign keys'. Leaving CASCADE off means
-- a dependency nobody knew about fails this migration rather than silently
-- going with it. Each table's own indexes, CHECKs and generated column go with
-- the table, and nothing that survives references any of them —
-- `postings.match_resume_id` was deliberately never a foreign key to `documents`.

-- DropTable
DROP TABLE "artifacts";

DROP TABLE "postings";

DROP TABLE "runs";

DROP TABLE "jobs";

DROP TABLE "posting_filters";

DROP TABLE "cover_letter_instructions";
