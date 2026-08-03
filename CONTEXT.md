# Job-search briefing platform

The single-user platform this repo is growing toward: a scheduled agent searches
a job board on the user's behalf and writes up what it found, and the dashboard
surfaces it. Today the scaffold, the deployed worker, the S3 storage layer, and
one end-to-end briefing path exist. The dashboard manages **Documents** and
**Briefings** but surfaces no **Brief** yet — `OVERVIEW.md` §Not built yet is
the current list.

## Language

**Briefing**:
The recurring thing a user sets up: search on this cadence and file what you
find. One briefing is one row in `jobs` — the settings page creates, pauses,
resumes and reschedules jobs and calls every one of them a briefing. It is the
user-facing word for a **Job**, and the only one the interface uses.

Each occurrence is a **briefing run**, and what that run produces is a **Brief**.
_Avoid_: calling the markdown a briefing — see **Brief**.

**Brief**:
The markdown one **Run** produces: a short document, one section per **Posting**,
written by the **Brief Writer** and uploaded through `@workspace/user-storage`'s
`BriefStore` to the `briefs` object kind. Landing in S3 is the success signal,
and the object key is what `artifacts` records. Built and running.
_Avoid_: digest, report (which means **Run Report**), briefing

**Scout**:
The agent that searches for postings and reports **Findings**. Carries the SEEK
search tool and nothing else, so it has no way to write anything: "a scraper
returns data and performs no side effects" is a property of its tool set, not a
line in its prompt. Today there is one; fanning out across several and merging
their results is unbuilt.
_Avoid_: scraper, crawler, search agent

**Brief Writer**:
The agent that renders **Findings** into the **Brief**'s markdown. Has no tools
at all, so it cannot look anything up and cannot supplement thin findings with
something it half-remembers. Not to be confused with the LangGraph runtime in
`agents-core`.
_Avoid_: synthesiser, orchestrator

**Cover Letter**:
A first-person draft for one **Posting**, written in the candidate's voice by
the **Letter Writer** from that Posting plus the candidate's own background
text. A draft the user edits, never a submittable letter: where a fact was not
supplied — a start date, a salary, a named recipient — it carries a literal
`[bracketed placeholder]`, because a plausible invention attributed to the user
is a lie.

Today it exists only as an agent and a CLI (`letter`) that writes one to disk.
Nothing stores one, and no **Document Type** of the same name is involved — that
label belongs to a letter the _user_ uploaded.
_Avoid_: application, letter of introduction

**Letter Writer**:
The agent that drafts a **Cover Letter**. Like the **Brief Writer** it has no
tools, and here that is containment rather than economy: it holds the
candidate's background in its context while a Posting's `highlights` — text
whoever paid for the advertisement wrote — reach its prompt verbatim. An agent
that could both read a CV and issue a request could be induced to put one inside
the other. When a page fetcher is eventually added it goes on a different agent
that never sees the profile.
_Avoid_: applicant agent, cover-letter bot

**Findings**:
The scout's output and the writer's input: a validated list of **Postings** plus
optional notes, defined by `FindingsSchema` in `@workspace/agents`. The hand-off
travels as JSON in a message and is parsed before the writer sees it — that
validation is the point of keeping the two agents apart, because data can be
checked and prose cannot. An empty findings list is a legitimate result.

Kept past the run: `runs.findings` is a nullable JSONB column, written after
the **Brief** exists and never fatally — a run that produced a brief succeeds
whatever happens to this write, and a failure only adds a warning to the
**Run**. NULL means either a run that failed before the hand-off, or one that
predates the column.

**Posting**:
One open job advertisement, with the URL a search actually returned. **Not** a
`jobs` row — see **Job** below, which is the collision worth being careful about.
A URL the scout assembled rather than received is a fabrication: the schema
rejects anything that is not a URL, and the worker separately rejects any URL
that does not appear verbatim in a search result.
_Avoid_: job, listing, vacancy, opening

**Search Criteria**:
What a candidate is looking for — titles, locations, keywords, exclusions,
preferred boards, a cap on how many postings a brief carries. Held in
`jobs.config` and interpreted by `apps/briefing-worker/src/job-search-config.ts`.
The platform stores that column and never reads inside it, so the meaning lives
with whatever runs the job.

Titles and locations are required and are what the settings form collects;
everything else is optional and reaches a row only by hand. The seam a resume
extractor would eventually write to.

**Job**:
A thing to run on a cadence, and a row in `jobs` — the Prisma model is `Job`.
**Never an employment opportunity** — that is a **Posting**. The word is
load-bearing in the schema (`jobs`, `job_id`, `dueJobs`, `claimJob`) and predates
the job-search product, so the schema keeps it and prose must not borrow it back.
The interface never says it: to a user this is a **Briefing**.

Owns its own cron expression and IANA timezone — Postgres is the source of truth
for cadence, not Terraform, so adding a job with a new cadence costs an INSERT
rather than an apply. A job with no `next_run_at` is not scheduled; that one
absence covers both paused and retired.

**Tick**:
The hourly invocation of the worker that asks the database which jobs are due and
runs them. What lives in Terraform is the tick, not any job's schedule — the tick
is the same for every job, so there is nothing left in it to drift. Hourly is
therefore the resolution of the whole system: a job's cron can name any hour,
and nothing finer than an hour is observable. A tick that finds nothing due is a
success.
_Avoid_: poll, sweep, cron run

**Run**:
One execution of a job, and a row in `runs`. Carries its status
(`running` → `succeeded` | `failed`, both terminal), the slot it occupied, and
its timings. This is the queryable state: what a dashboard would list and what a
filter runs against.

Distinct from the **Run Report** below, which is the log line. The two complement
each other and neither replaces the other — the row is queryable, the report
keeps the diagnostics nothing will ever query, and the report is the only record
left when a run dies before it can write a row.

A run with no `scheduled_for` is ad-hoc: it occupies no slot, and any number of
them may exist for one job.
_Avoid_: execution, attempt, task run

**Artifact**:
A row in `artifacts`, and the claim that a **Run** produced something durable. It
holds an S3 object key and nothing else of the content — `object_key` is UNIQUE
and a CHECK rejects URL schemes and leading slashes, so Postgres cannot be talked
into holding a URL or a blob. Written only after the upload returns, because the
reverse order can leave a row pointing at nothing.

`artifacts.run_id` is `NOT NULL` and references `runs`, so there is no row shape
for something a person uploaded. A **Document** is therefore recorded nowhere but
S3.
_Avoid_: file, output, attachment

**Account**:
The identity someone signs in with, held by Neon Auth in the `neon_auth` schema
of this same database. Neon owns its shape; we never write to it. An account
exists as soon as someone completes an OAuth flow — having one says nothing about
whether they are allowed in.
_Avoid_: login, profile, credentials

**User**:
The platform identity, and a row in `users`. What `jobs.user_id` references and
what becomes the `userId` segment of every S3 object key, which is why it stays a
uuid this repo generates. Deliberately carries no name or email — those live on
the **Account**, and `users.auth_user_id` is the one link between the two.

The two are not one thing wearing two hats: a user may exist with no account, and
an account may exist with no user (someone signed in but is not on the allowlist,
so nothing was ever minted for them).

**Document**:
Something the user uploaded themselves — a CV, a cover letter, whatever they want
kept beside their job search. The dashboard section is called **Documents**, and
it is the user-facing word for the whole shelf.

⚠️ **Three different meanings of "resume" collide here, and one of them is a key
segment.** The storage _kind_ is `resumes`, so an object key reads
`prod/{userId}/resumes/{id}.pdf` no matter what the document actually is; a cover
letter is stored under `resumes` too. Meanwhile **Resume** is also one of the five
selectable **Document Types**. The kind is not renamed because a kind is a key
segment, an object tag and a file-type allowlist at once — the tag is what the S3
lifecycle rules filter on, so renaming it would orphan every existing object's
retention. Read `resumes` as "the shelf uploads go on", not as "these are all
CVs".
_Avoid_: file, attachment, upload (as a noun)

**Document Type**:
What the user says a **Document** is: `resume`, `cover-letter`, `portfolio`,
`reference` or `other`. Stored as S3 object metadata (`document-type`) within the
one `resumes` kind, **not** as a kind of its own — a separate kind buys only
separate retention and separate accepted file types, and these five want neither.

Fixed at upload. S3 metadata cannot be changed without copying the object onto
itself, which `UserObjectStore` deliberately does not expose, so relabelling means
re-uploading. Absent is a legitimate value: nothing uploaded before the field
existed carries one, and the list view shows those as unlabelled rather than
guessing.
_Avoid_: category, kind (which means the storage kind), tag (which means the S3
tag that drives retention)

**Allowlist**:
The set of email addresses permitted past the gate, read from
`AUTH_ALLOWED_EMAILS`. Signup is closed and this is what closes it — Neon Auth
will happily create an account for anyone who completes an OAuth flow, so being
refused happens on our side, on every request. An unset list refuses everyone.
_Avoid_: whitelist, approved users, invite list

**Gate**:
The two layers that together refuse an anonymous request: `proxy.ts`, which
matches everything but static assets and so is closed by default, and the
authoritative check inside the route or page. Neither is sufficient alone, and
that is the point — the proxy is a routing concern, and the route is what must
not be reachable by accident.

On a **non-GET** request the first layer is weaker than it looks: the auth SDK
cannot evaluate a POST session, so the proxy falls back to checking that a session
cookie is merely present. Every Server Action arrives that way, which makes the
check inside the action the only real one.

**Run Report**:
The single structured log line a briefing run emits describing its outcome —
`event: "briefing-run"`, carrying the search count, the model calls, and the
object key. The artifact a human queries to verify a run happened. A **Tick
Report** (`event: "tick"`) is its per-tick counterpart, answering "was there
anything to do" rather than "what happened in this run".
_Avoid_: run record, run log, result row

**Trace**:
The transcript of one **Run**: every step boundary, prompt, model message and tool
round trip. The third thing beside the **Run** and the **Run Report**, and neither
replaces it — the row is queryable state, the report is the outcome, and the trace
is what the run actually did on the way there. It answers "why did it do that",
which the other two structurally cannot: a report saying `"searches":2` cannot say
what was searched for.

Two independent mechanisms produce one, and they do not feed each other:

- **The trace sink** (`apps/briefing-worker/src/trace.ts`) is a stream of typed
  events `runBriefing` emits into an optional sink. Production passes none, and a
  run with no sink emits nothing and behaves identically; the local `watch`
  harness passes one and renders it.
- **Langfuse** receives a trace per agent run over OpenTelemetry —
  `generate-briefing` from the worker, `chat-response` from the dashboard —
  through `@workspace/langfuse`. Missing keys make it a no-op rather than an
  error, so this too is a thing a runtime opts into.

_Avoid_: log, debug output, history
