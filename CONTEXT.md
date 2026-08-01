# Daily Briefing Platform

The single-user platform this repo is growing toward: a scheduled agent
produces a daily job-search briefing, and the dashboard surfaces it. Today the
scaffold, the deployed worker, the S3 storage layer, and one end-to-end
briefing path exist. The dashboard manages **Documents** but surfaces no
briefing yet — `OVERVIEW.md` §Not built yet is the current list.

## Language

**Briefing**:
The digest a scheduled run produces: a **Scout** searches the web for job
postings matching the candidate's **Search Criteria**, a **Brief Writer** turns
the resulting **Findings** into a single markdown file, and the worker writes it
through `@workspace/user-storage`'s brief store to S3 — landing there is the
success signal. Built and running.

**Scout**:
The agent that searches for postings and reports **Findings**. Carries the
search tool and nothing else, so it has no way to write anything: "a scraper
returns data and performs no side effects" is a property of its tool set, not a
line in its prompt. Today there is one; a later change fans out across several
and merges their results.
_Avoid_: scraper, crawler, search agent

**Brief Writer**:
The agent that renders **Findings** into the briefing's markdown. Has no tools
at all, so it cannot look anything up and cannot supplement thin findings with
something it half-remembers. Not to be confused with the LangGraph runtime in
`agents-core`.
_Avoid_: synthesiser, orchestrator

**Findings**:
The scout's output and the writer's input: a validated list of **Postings**
plus optional notes, defined by `FindingsSchema` in `@workspace/agents`. The
hand-off travels as JSON in a message and is parsed before the writer sees it —
that validation is the point of keeping the two agents apart, because data can
be checked and prose cannot. An empty findings list is a legitimate result.

**Posting**:
One open job advertisement, with the URL a search actually returned. **Not** a
`jobs` row — see **Job** below, which is the collision worth being careful
about. A URL the scout assembled rather than received is a fabrication, and the
schema rejects it.
_Avoid_: job, listing, vacancy, opening

**Search Criteria**:
What a candidate is looking for — titles, locations, keywords, exclusions,
preferred boards — held in `jobs.config` and interpreted by
`apps/briefing-worker/src/job-search-config.ts`. The platform stores that column
and never reads inside it, so the meaning lives with whatever runs the job.
Filled in by hand today; the seam a resume extractor will eventually write to.

**Job**:
A thing to run on a cadence, and a row in `jobs`. **Never an employment
opportunity** — that is a **Posting**. The word is load-bearing in the schema
(`jobs`, `job_id`, `dueJobs`, `JobStore`) and predates the job-search product,
so the schema keeps it and prose must not borrow it back.

Owns its own cron expression and IANA timezone — Postgres is the source of
truth for cadence, not Terraform, so adding a job with a new cadence costs an
INSERT rather than an apply. A job with no `next_run_at` is not scheduled; that
one absence covers both paused and retired.

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

**Document**:
Something the user uploaded themselves — a CV, a cover letter, whatever they
want kept beside their job search. The dashboard section is called
**Documents**, and it is the user-facing word for the whole shelf.

⚠️ **Three different meanings of "resume" collide here, and one of them is a
key segment.** The storage _kind_ is `resumes`, so an object key reads
`prod/{userId}/resumes/{id}.pdf` no matter what the document actually is; a
cover letter is stored under `resumes` too. Meanwhile **Resume** is also one of
the five selectable **Document Types**. The kind is not renamed because a kind
is a key segment, an object tag and a file-type allowlist at once — the tag is
what the S3 lifecycle rules filter on, so renaming it would orphan every
existing object's retention. Read `resumes` as "the shelf uploads go on", not
as "these are all CVs".
_Avoid_: file, attachment, upload (as a noun)

**Document Type**:
What the user says a **Document** is: `resume`, `cover-letter`, `portfolio`,
`reference` or `other`. Stored as S3 object metadata (`document-type`) within
the one `resumes` kind, **not** as a kind of its own — a separate kind buys only
separate retention and separate accepted file types, and these five want
neither.

Fixed at upload. S3 metadata cannot be changed without copying the object onto
itself, which `UserObjectStore` deliberately does not expose, so relabelling
means re-uploading. Absent is a legitimate value: nothing uploaded before the
field existed carries one, and the list view shows those as unlabelled rather
than guessing.
_Avoid_: category, kind (which means the storage kind), tag (which means the S3
tag that drives retention)

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

On a **non-GET** request the first layer is weaker than it looks: the auth SDK
cannot evaluate a POST session, so the proxy falls back to checking that a
session cookie is merely present. Every Server Action arrives that way, which
makes the check inside the action the only real one.

**Run Report**:
The single structured log line a briefing run emits describing its outcome —
`event: "briefing-run"`, carrying the search count, the model calls, and the
object key. The artifact a human queries to verify a run happened. A **Tick
Report** is its per-tick counterpart, answering "was there anything to do"
rather than "what happened in this run".
_Avoid_: run record, run log, result row
