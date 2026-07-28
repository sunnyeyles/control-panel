-- The four platform nouns and nothing else: users, jobs, runs, artifacts.
--
-- Everything scraping-shaped lives in `jobs.config`, and everything the
-- platform queries, filters, sorts or constrains is a real column. That line is
-- the schema's one organising rule.
--
-- Forward-only. There is no down migration for this file or any other — an
-- unwanted change is undone by writing the next one.

-- `gen_random_uuid()` is built into Postgres from 13, so no extension is
-- created here and no server version gates this file.

create table users (
  -- Feeds the userId segment of every S3 object key this user owns.
  id         uuid        primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- Identifying fields — email, display name — belong to the authentication
-- effort and are deliberately absent.

create table jobs (
  id      uuid not null primary key default gen_random_uuid(),
  -- restrict, never cascade: deleting a user who owns jobs should fail loudly
  -- rather than silently erase their provenance.
  user_id uuid not null references users (id) on delete restrict,
  -- Human label. Unique per user, which is also what makes the seed idempotent.
  name    text not null,
  -- Pipeline-interpreted only. No CHECK on its shape: with no ORM chosen there
  -- is nowhere coherent for that type to live in SQL, so validation is the
  -- application's job.
  config  jsonb not null default '{}'::jsonb,

  -- The cadence, and the source of truth for it. Postgres owns this, not
  -- Terraform — EventBridge fires an hourly tick that asks what is due.
  schedule_cron     text not null,
  -- An IANA zone name, never a UTC offset: an offset cannot express "09:00
  -- local across DST".
  schedule_timezone text not null default 'UTC',
  -- Derived state, materialized so the tick can select on it. Recomputed in
  -- application code (`computeNextRunAt`) on insert, on a schedule edit, and in
  -- the claim transaction.
  --
  -- NULL means NOT SCHEDULED, and covers both paused and retired. That is why
  -- there is no `enabled` column and no `retired_at` — one column carries both
  -- "when next" and "whether at all", which is the honest cost of collapsing
  -- them.
  next_run_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, name)
);

create table runs (
  id     uuid not null primary key default gen_random_uuid(),
  job_id uuid not null references jobs (id) on delete restrict,

  -- The slot this run was meant to occupy, taken from the `next_run_at` value
  -- the claim observed — never from a clock, so a run crossing midnight cannot
  -- silently produce a different occurrence.
  --
  -- NULL means ad-hoc: the run has no scheduled occurrence. Inapplicable rather
  -- than missing, which is the case NULL is genuinely for. There is no
  -- `is_manual` column because `scheduled_for IS NULL` already is that test.
  scheduled_for timestamptz,

  -- running -> succeeded | failed, and both are terminal. text + CHECK rather
  -- than an enum, because ORM support for Postgres enums is uneven and this map
  -- may not narrow the deferred ORM choice. A CHECK validates the value; the
  -- transition is enforced by a conditional UPDATE in @workspace/db.
  status text not null check (status in ('running', 'succeeded', 'failed')),

  -- The claim creates the row and starts the run in one transaction, so a
  -- separate `created_at` would always equal `started_at`. There are no
  -- retries, so it would never diverge either.
  started_at  timestamptz not null default now(),
  -- NULL while running. The sole in-flight marker.
  finished_at timestamptz,

  -- Per-source failure detail, pipeline-shaped. "Succeeded with warnings" is
  -- status = 'succeeded' with a non-empty failure payload, not a fourth status
  -- — two places to encode one fact can disagree.
  --
  -- The database complements the run report rather than replacing it: this row
  -- holds what a query filters or a dashboard renders, and the CloudWatch line
  -- keeps llmCalls / toolRoundTrips and remains the only record when a run dies
  -- before it can write anything at all.
  failure jsonb
);

create table artifacts (
  id     uuid not null primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete restrict,

  -- An S3 object key, never a URL and never content. The name says key and the
  -- CHECK enforces it: no scheme prefix, no leading slash. `unique` because
  -- recording the same object twice is always a bug.
  --
  -- No `kind` column — the key already encodes environment/user/kind, and
  -- `parseObjectKey()` in @workspace/user-storage recovers them. The key is
  -- opaque text to Postgres, which is what keeps the arrow between these two
  -- packages from being drawn at all.
  object_key text not null unique
    check (object_key !~ '^[a-z][a-z0-9+.-]*://' and object_key not like '/%'),

  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes. Each one is tied to the single query it serves; there are no
-- speculative indexes, because one nobody needs is still carried on every
-- write.
-- ---------------------------------------------------------------------------

-- The claim's ON CONFLICT target, and lookup by occurrence.
--
-- A partial unique index rather than a table constraint, so the DDL *states*
-- that unlimited ad-hoc runs are allowed instead of resting on the reader
-- knowing Postgres treats NULLs as distinct inside UNIQUE. It is also immune to
-- someone later "tidying" it into NULLS NOT DISTINCT, which would silently cap
-- the system at one manual run per job forever.
--
-- The cost: every ON CONFLICT against it must repeat this WHERE clause to infer
-- the index. Omitting it errors out rather than misbehaving, which is why the
-- trade is acceptable.
create unique index runs_job_scheduled_for_key
  on runs (job_id, scheduled_for)
  where scheduled_for is not null;

-- The hourly tick: `where next_run_at <= now()`. Partial on exactly the
-- predicate that makes a job schedulable, so unscheduled jobs are not merely
-- filtered out — they are absent from the index.
create index jobs_next_run_at_idx
  on jobs (next_run_at)
  where next_run_at is not null;

-- The dashboard's job detail view: this job's recent runs, newest first. Also
-- what would serve stuck-run detection, which is why `runs.status` has no index
-- of its own — three values, and the only selective one is selective only in
-- combination with `started_at`.
create index runs_job_started_at_idx on runs (job_id, started_at desc);

-- Postgres does not index the referencing side of a foreign key. This one is
-- joined on to answer "which artifacts did this run produce".
--
-- `jobs.user_id` needs no equivalent: the `unique (user_id, name)` constraint
-- already indexes it, and `runs.job_id` leads the index above.
create index artifacts_run_id_idx on artifacts (run_id);
