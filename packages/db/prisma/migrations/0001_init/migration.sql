-- The four platform nouns and nothing else: users, jobs, runs, artifacts.
--
-- Everything scraping-shaped lives in `jobs.config`, and everything the
-- platform queries, filters, sorts or constrains is a real column.
--
-- Forward-only. There is no down migration for this file or any other.
--
-- Partial indexes and CHECK constraints below are intentional and must survive
-- any future `prisma migrate` edit — Prisma's schema DSL cannot express them.

-- `gen_random_uuid()` is built into Postgres from 13, so no extension is
-- created here.

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- text, not uuid: Better Auth mints nanoids. Nullable so unlinked users
    -- remain legal; UNIQUE still maps one auth identity to at most one row.
    -- Deliberately NOT a foreign key to `neon_auth`.
    "auth_user_id" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "schedule_cron" TEXT NOT NULL,
    "schedule_timezone" TEXT NOT NULL DEFAULT 'UTC',
    -- NULL means NOT SCHEDULED (paused or retired). No `enabled` column.
    "next_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    -- NULL means ad-hoc. Uniqueness of scheduled slots is the partial unique
    -- index below, not a table unique.
    "scheduled_for" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "failure" JSONB,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed'))
);

CREATE TABLE "artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifacts_object_key_check" CHECK (
      "object_key" !~ '^[a-z][a-z0-9+.-]*://'
      AND "object_key" NOT LIKE '/%'
    )
);

-- Restrict, never cascade: deleting a user who owns jobs (or a job with runs)
-- should fail loudly rather than silently erase provenance.
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifacts"
  ADD CONSTRAINT "artifacts_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "users_auth_user_id_key" ON "users"("auth_user_id");

CREATE UNIQUE INDEX "jobs_user_id_name_key" ON "jobs"("user_id", "name");

CREATE UNIQUE INDEX "artifacts_object_key_key" ON "artifacts"("object_key");

-- The claim's ON CONFLICT target. Partial so unlimited ad-hoc runs
-- (`scheduled_for IS NULL`) stay legal, and so a later NULLS NOT DISTINCT tidy
-- cannot silently cap the system at one manual run per job.
CREATE UNIQUE INDEX "runs_job_scheduled_for_key"
  ON "runs" ("job_id", "scheduled_for")
  WHERE "scheduled_for" IS NOT NULL;

-- The hourly tick: `where next_run_at is not null and next_run_at <= now()`.
CREATE INDEX "jobs_next_run_at_idx"
  ON "jobs" ("next_run_at")
  WHERE "next_run_at" IS NOT NULL;

CREATE INDEX "runs_job_started_at_idx" ON "runs" ("job_id", "started_at" DESC);

CREATE INDEX "artifacts_run_id_idx" ON "artifacts" ("run_id");
