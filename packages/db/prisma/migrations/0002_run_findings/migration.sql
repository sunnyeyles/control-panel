-- What the scout found, kept on the run that found it.
--
-- Nullable, and every run that predates this column stays NULL: the findings
-- were dropped once the brief was written, so there is nothing to backfill
-- from. Forward-only, like every migration here.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "findings" JSONB;
