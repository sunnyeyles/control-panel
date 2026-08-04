# Job-search briefing pipeline

A scheduled worker turns a candidate's search criteria into a private, per-user
job-search brief.

Each run: read the criteria → query SEEK's live listings for matching postings →
validate the findings → compose markdown → upload to private S3 → record the
object key and the findings in Neon.

Vocabulary is in `CONTEXT.md`, and it is worth reading first — in particular
**Job** means "a row in `jobs`, a thing that runs on a cadence" and never an
employment opportunity, which is a **Posting**. To a user a job is a
**Briefing**, and what one run of it produces is a **Brief**.

## Where it lives

| Stage                                        | Owner                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard — chat, documents, briefings       | `apps/dashboard/` (Next.js 16 App Router, Vercel)                                                                                        |
| Lambda entrypoint + hourly tick              | `apps/briefing-worker/src/` (`index.ts`, `run-tick.ts`)                                                                                  |
| A run someone triggered from the UI          | `apps/briefing-worker/src/run-ad-hoc.ts`, asked for by `apps/dashboard/lib/briefing-runs/`                                               |
| One briefing run                             | `apps/briefing-worker/src/run-briefing.ts`                                                                                               |
| What `jobs.config` means                     | `apps/briefing-worker/src/job-search-config.ts`                                                                                          |
| The named agents                             | `packages/agents/src/` — one `createX()` factory per module                                                                              |
| The scout↔writer contract                    | `packages/agents/src/findings.ts`                                                                                                        |
| The search-criteria contract                 | `packages/agents/src/criteria.ts`                                                                                                        |
| Proposing criteria from a resume             | `apps/dashboard/lib/jobs/suggest-criteria-actions.ts`, reading through `apps/dashboard/lib/cover-letters/candidate-background.ts`        |
| The tool catalog                             | `packages/agent-tools/src/` — one tool per module                                                                                        |
| Orchestrator graph, state, model             | `packages/agents-core/src/`                                                                                                              |
| Jobs, runs, artifacts                        | `packages/db/src/` (Prisma Client + domain helpers) and `packages/db/prisma/`                                                            |
| S3 read/write                                | `packages/user-storage/src/` — extend `brief-store.ts` / `resume-store.ts` / `cover-letter-store.ts`, never import the AWS SDK elsewhere |
| Langfuse tracing                             | `packages/langfuse/src/`, wired in each runtime's entry point                                                                            |
| EventBridge schedule, bucket, IAM, lifecycle | `infra/aws/` (`briefing-worker.tf`, `user-storage.tf`, `vercel-dashboard.tf`)                                                            |

**The tool catalog is three modules and there is no fetch tool.**
`seek-search.ts` queries SEEK's live inventory through an Apify actor,
`web-search.ts` is a general Tavily search, and `time.ts` answers what the
current time is. Nothing retrieves an arbitrary URL, and nothing should acquire
that ability casually — a fetcher is a security surface (SSRF, redirect chains,
response size, prompt injection from a page the model then acts on). The scout
carries `seek_search` alone; the dashboard's assistant carries `allTools`, which
is `get_current_time` and `web_search` — `seekSearch` is deliberately not in it.

## Rules

- **S3 stays private.** Neon stores object keys only — never URLs, never blob
  content. The `artifacts.object_key` CHECK enforces it.
- **Runs are idempotent.** `briefId` is the run id and the key partitions on the
  occurrence, so re-executing a run overwrites one object rather than making a
  second. Claiming is at-most-once; every duplicate occurrence is a paid run.
- **Two ways in, one pipeline, two claims.** The hourly tick claims a _slot_
  (`claimJob`, guarded by the partial unique index on
  `(job_id, scheduled_for)`); a run someone triggers claims the _row_
  (`claimAdHocRun`, guarded by `runs.claimed_at`). Both are at-most-once and
  neither is optional — the trigger is an asynchronous Lambda invocation, which
  AWS delivers at least once. A triggered run takes no slot and leaves
  `next_run_at` alone.
- **A failed tick throws; a failed triggered run does not.** The tick's throw is
  what produces the `Errors` datapoint its alarm watches, and that alarm is
  daily and latching. A run a person started reports itself on its `runs` row
  and in the UI, so routing it into the alarm as well would spend the only
  signal that says _the schedule is broken_.
- **The scout returns data, not side effects.** No writes, no uploads, no DB
  calls inside it. It carries one tool, so this is structural.
- **URLs are copied, never composed.** Every posting must carry a URL a search
  actually returned; the findings schema rejects anything that is not a URL, and
  the worker rejects any URL that does not appear verbatim in a search result.
- **A run with no successful search fails.** Well-formed findings that never
  touched a live search would produce a confident brief citing postings nobody
  looked up — worse than no brief.
- **New `kinds.ts` entries need a matching `object_kinds` entry in Terraform**,
  or the objects get no retention and writes 403 for want of the per-kind grant.
- **Tracing is opt-in and never load-bearing.** `@workspace/langfuse` is a no-op
  without keys, and the worker's own trace sink emits nothing when no sink is
  passed. A run must behave identically either way.

## Flow

```mermaid
flowchart TD
    E[EventBridge Scheduler — hourly tick] --> F[AWS Lambda briefing worker]
    B2[Dashboard — Run now] -->|insert ad-hoc runs row| D
    B2 -->|async invoke, names the run| F
    F --> D[(Neon Postgres — jobs, runs, via Prisma)]
    D -->|due job + criteria| G[Scout agent]
    G --> T[seek_search tool → Apify SEEK actor]
    T --> X[seek.com.au live listings]
    G -->|Findings JSON, validated| L[Brief writer agent]
    L --> Z[Markdown]
    Z --> U[Upload to private S3]
    U --> V[(S3 bucket — markdown briefs)]
    V --> W[Record object key in artifacts]
    W --> K[Keep findings on the run row]
    F --> CW[CloudWatch logs & metrics]
    F -.->|optional, keys permitting| LF[Langfuse trace: generate-briefing]
```

## Not built yet

The pipeline above runs end to end. These are the parts of the intended product
that do not exist, and nothing in the code today implies them. One entry has
since gone half-built rather than leaving the list, so **a solid edge below is a
path that exists and a dotted one is still the gap**:

```mermaid
flowchart TD
    B[Document in S3] --> C[Profile extractor]
    C --> F[New-briefing form — proposed, then edited]
    F --> D[(Neon — jobs.config)]
    B -.->|missing: nothing turns a document into<br/>criteria with nobody watching| D
    D --> P[Briefing pipeline above]
    P --> M[Several scouts, merged and ranked]
    P --> N[Sending a cover letter]
    P --> Q[A viewer for the brief itself]
```

- **Profile extraction — half closed, and it is worth being exact about which
  half.** Upload was always there: `/documents` writes to the `resumes` object
  kind through a Server Action, and lists, downloads and deletes what is there.
  Reading a stored document came next —
  `apps/dashboard/lib/cover-letters/candidate-background.ts` fetches the newest
  document labelled `resume` and turns it into text for the **Letter Writer**,
  through `profile-text.ts` (#86) — `.md`, `.txt`, PDF via `unpdf` and DOCX via
  `mammoth`. `.doc`, `.odt` and `.rtf` still upload and still have no parser,
  and are refused by name.

  Extraction proper now exists on top of that. The **Profile Extractor**
  (`packages/agents/src/profile-extractor.ts`) reads that text and proposes
  **Search Criteria** — titles and keywords from what the CV actually names, and
  a location only when the CV states one, otherwise an empty list and a sentence
  in `notes` saying so. `packages/agents/src/criteria.ts` is what makes the
  answer checkable: `SearchCriteriaSchema` both renders into the prompt and
  validates what comes back, so reading a CV — the one step with no source to
  re-fetch and nothing to check a claim against — is verified on shape at least.
  `apps/dashboard/lib/jobs/suggest-criteria-actions.ts` is the Server Action
  behind **Suggest from my resume** on the new-briefing form. It reuses
  `loadCandidateBackground()` and its bounds check rather than adding a document
  picker, deliberately: "which document is my resume" has to mean one thing
  across the app, or a **Cover Letter** and a **Briefing** end up drawn from
  different files with nothing saying so.

  What is _not_ built is anything that closes the loop without a person in it.
  The extractor **proposes**: the criteria arrive in the form's fields, the user
  edits them, and `jobs.config` is written by the ordinary create action when
  they press Create. The suggestion itself persists nothing — which is why the
  action calls no `refresh()`, having invalidated nothing — so a suggestion
  someone abandons leaves no trace anywhere. Nor does any Postgres row point at
  an upload: `artifacts.run_id` is `NOT NULL` and references `runs`, so there is
  still no row shape for one, and nothing records which **Document** a briefing's
  criteria came out of.

- **Fan-out across several scouts, with merge and rank.** One scout runs today.
  Fanning out replaces what produces `Findings` and leaves everything downstream
  of it alone.
- **Sending a cover letter.** Drafting one is built (#84): a Draft button on
  each **Posting** on `/briefings` runs the **Letter Writer** and stores the
  result at `prod/{userId}/cover-letters/{postingId}.md`, keyed on the Posting
  so a redraft overwrites one object. Seeing and downloading them is built too
  (#85): `/briefings` lists every stored letter with when it was drafted and
  which Posting it belongs to —
  `apps/dashboard/lib/cover-letters/list-cover-letters.ts`, which pays one
  `HeadObject` per letter because a listing carries no user metadata — a Posting
  that already has one says so instead of offering a first draft, and
  `/api/cover-letters/{postingId}` hands the Markdown back as a file. The letter
  is written from the newest **Document** labelled `resume`, and since #86 that
  can be a PDF or a DOCX as well as `.md` or `.txt`. Telling the writer how to
  write is built too: **Letter Instructions** are a per-user row in
  `cover_letter_instructions`, edited from `/settings`, composed onto the
  writer's system prompt by `coverLetterSystemPrompt()` and applied to every
  draft — free-text rules, plus an optional example letter that is fenced as a
  style reference and never as a source of facts. So tone, wording and structure
  are settable, and redrafting a Posting applies them. Reading and editing one
  in the app is built as well: an **Edit letter** button beside the draft button
  opens the stored Markdown as rich text in `FileEditorDialog`, and **Save**
  writes it back over the same object — carrying `drafted-at` and the letter's
  provenance across, because an edit is not a drafting. A save refuses when no
  letter exists at that address, which is what keeps an action that _does_ take
  letter text from a form out of the business of creating one. What is still
  missing is sending it. Ticketed under #77;
  `docs/cover-letter-agent-plan.md` is the staged plan.

- **A viewer for the brief itself.** `/briefings` shows what a run _found_: the
  **Postings** from each briefing's most recent successful **Run**, read out of
  the `runs.findings` record by `apps/dashboard/lib/briefings/latest-postings.ts`
  (#83). What is still missing is the **Brief** — the markdown that run wrote —
  and that gap is structural rather than merely unbuilt: the dashboard's IAM
  grants are `prod:resumes` and `prod:cover-letters`, and a brief lives under
  `prod:briefs`, so the app cannot read one without an infrastructure change.
  Widening the grant for cover letters (#84) deliberately did not widen it here
  — `tests/vercel_dashboard.tftest.hcl` asserts the exact key set, and that the
  dashboard's and the worker's grants stay disjoint. Nothing lists **Runs**
  either, and `latestArtifactForJob()` still has no caller outside its own tests
  — the briefings page deliberately does not use it, because it orders on run
  start _and_ artifact creation and stops being well defined once a run writes
  more than one artifact. What _does_ read a **Run** now is the briefings page's
  status line: `apps/dashboard/lib/briefing-runs/run-activity.ts` shows each
  briefing's most recent Run whatever became of it — running, failed, or too
  long in `running` to still be believed — which is what the **Run now** button
  needs to be watchable. That is a status line, not a history: nothing lists
  more than one Run per briefing, and nothing can cancel one.

## Infrastructure

- Frontend and application on Vercel; database is Neon Postgres, reached through
  Prisma Client over a `pg` driver adapter.
- The scheduled worker runs on AWS Lambda, triggered hourly by EventBridge
  Scheduler. The tick is the same for every job, so a job's own cadence is a row
  in Postgres rather than anything in Terraform.
- S3 privately stores generated markdown briefs, uploaded documents and drafted
  cover letters. IAM is least-privilege and bounded by a permissions boundary;
  grants are per environment and kind, so the worker holds `prod:briefs` and the
  dashboard's Vercel OIDC role holds `prod:resumes` and `prod:cover-letters`,
  and the two roles' grants are disjoint — the dashboard cannot forge or delete
  a briefing.
- Secrets are AWS Secrets Manager shells whose values are set by hand —
  Terraform provisions containers it can never read.
- All AWS infrastructure is Terraform under `infra/aws/`, which Turborepo does
  not cover. CloudWatch provides logs, metrics and failure alarms.
- Langfuse receives one trace per agent run when its keys are present:
  `generate-briefing` from the worker, and `chat-response`, `cover-letter` and
  `search-criteria` from the dashboard. All retain full prompts, tool I/O and
  outputs by design — which for the last two means the candidate's CV, so the
  keys are what decides whether it leaves the machine.

## Design requirements

- Keep searching, composition, storage, database and scheduling concerns
  separated, with typed interfaces between them.
- Make individual scouts replaceable without changing the rest of the pipeline.
- Keep AWS-specific code behind adapters. Exactly two non-test files import the
  S3 SDK — `packages/user-storage/src/s3-user-object-store.ts`, and
  `apps/dashboard/lib/storage.ts`, which exists only to attach Vercel's OIDC
  credential provider through the store's `client` seam. The package deliberately
  accepts no credentials. One further file imports the **Lambda** SDK —
  `apps/dashboard/lib/briefing-runs/invoke-worker.ts` — for the same reason and
  behind the same kind of seam: it exposes a `BriefingInvoker` interface, so the
  action that triggers a run never sees a client. In the worker, `index.ts` is
  the only file that knows it runs on Lambda, and it is where the invocation
  payload is read.
- Preserve source URLs for traceability.
- Never make the bucket or the briefs public, and never store a public URL as the
  file reference; the object key is the persistent reference.
- Design for local development and automated testing: `runBriefing` takes its
  agents, its artifact write and its trace sink through injectable seams, so a
  run can be exercised without an API key, a database or AWS credentials.
