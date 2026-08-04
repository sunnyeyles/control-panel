-- When the worker picked a run up, as distinct from when the run was requested.
--
-- The scheduled path needs no such column: `claimJob` claims the *slot*, and the
-- partial unique index on (job_id, scheduled_for) makes that at-most-once. An
-- ad-hoc run occupies no slot — `scheduled_for` is NULL and the index does not
-- cover it — so it needs its own claim, and this is what one writes.
--
-- The reason it must exist at all is that AWS asynchronous invocation is
-- at-least-once: the same payload can be delivered twice, and without a claim
-- the second delivery would start a second paid LLM run. The compare-and-swap
-- is `SET claimed_at = now() WHERE claimed_at IS NULL`, exactly the shape
-- `claimJob` uses, and zero rows affected means someone already has it.
--
-- Nullable, and every run that predates this column stays NULL. Nothing reads
-- it except the ad-hoc claim, so there is nothing to backfill and no reader to
-- confuse. Forward-only, like every migration here.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "claimed_at" TIMESTAMPTZ(6);
