# Daily Briefing Platform

The single-user platform this repo is growing toward: a scheduled agent
produces a daily briefing, and the dashboard surfaces it. Today the scaffold,
the deployed worker, and the S3 storage layer exist; the briefing itself does
not.

## Language

**Briefing**:
The daily digest the real agent will eventually produce: several search
agents fan out over one fixed topic using a Tavily search tool, an
orchestrator agent synthesizes their findings into a single markdown file,
and the worker writes it through `@workspace/user-storage`'s brief store to
S3 — landing there is the success signal. Out of scope for the current
foundation work (which proves the pipeline with a trivial task instead); the
shape is decided but nothing here is built yet.

**Search Agent**:
One of the fan-out agents in a briefing run; searches the internet on the
fixed topic via Tavily and reports findings to the orchestrator.

**Orchestrator** (briefing context):
The agent that synthesizes all search agents' findings into the briefing's
single markdown file. Not to be confused with the LangGraph runtime in
`agents-core`.

**Proof Run**:
One scheduled execution of the trivial agent task that proves the AWS
foundation works end to end. Deliberately not a briefing.
_Avoid_: heartbeat, smoke test, ping

**Job**:
A thing to run on a cadence, and a row in `jobs`. Owns its own cron expression
and IANA timezone — Postgres is the source of truth for cadence, not Terraform,
so adding a job with a new cadence costs an INSERT rather than an apply. A job
with no `next_run_at` is not scheduled; that one absence covers both paused and
retired.

**Tick**:
The hourly invocation of the worker that asks the database which jobs are due
and runs them. What lives in Terraform is the tick, not any job's schedule —
the tick is the same for every job, so there is nothing left in it to drift.
A tick that finds nothing due is a success.
_Avoid_: poll, sweep, cron run

**Run**:
One execution of a job, and a row in `runs`. Carries its status
(`running` → `succeeded` | `failed`, both terminal), the slot it occupied, and
its timings. This is the queryable state: what the dashboard lists and what a
filter runs against.

Distinct from the **Run Report** below, which is the log line. The two
complement each other and neither replaces the other — the row is queryable,
the report keeps the diagnostics nothing will ever query, and the report is the
only record left when a run dies before it can write a row.

A run with no `scheduled_for` is ad-hoc: it occupies no slot, and any number of
them may exist for one job.
_Avoid_: execution, attempt, task run

**Account**:
The identity someone signs in with, held by Neon Auth in the `neon_auth`
schema of this same database. Neon owns its shape; we never write to it. An
account exists as soon as someone completes an OAuth flow — having one says
nothing about whether they are allowed in.
_Avoid_: login, profile, credentials

**User**:
The platform identity, and a row in `users`. What `jobs.user_id` references
and what becomes the `userId` segment of every S3 object key, which is why it
stays a uuid this repo generates. Deliberately carries no name or email —
those live on the **Account**, and `users.auth_user_id` is the one link
between the two.

The two are not one thing wearing two hats: a user may exist with no account
(the worker creates owners that never sign in), and an account may exist with
no user (someone signed in but is not on the allowlist, so nothing was ever
minted for them).

**Allowlist**:
The set of email addresses permitted past the gate, read from
`AUTH_ALLOWED_EMAILS`. Signup is closed and this is what closes it — Neon Auth
will happily create an account for anyone who completes an OAuth flow, so
being refused happens on our side, on every request. An unset list refuses
everyone.
_Avoid_: whitelist, approved users, invite list

**Gate**:
The two layers that together refuse an anonymous request: `proxy.ts`, which
matches everything but static assets and so is closed by default, and the
authoritative check inside the route or page. Neither is sufficient alone, and
that is the point — the proxy is a routing concern, and the route is what must
not be reachable by accident.

**Run Report**:
The single structured log line a proof run emits describing its outcome; the
artifact a human queries to verify a run happened. A **Tick Report** is its
per-tick counterpart, answering "was there anything to do" rather than "what
happened in this run".
_Avoid_: run record, run log, result row
