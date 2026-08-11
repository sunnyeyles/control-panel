# Job-search briefing pipeline

A scheduled worker turns a candidate's search criteria into a private, per-user
job-search brief.

Each run: read the criteria → query each job board's live listings for matching
postings → validate the findings → drop anything the user's title filter rules
out → compose markdown → upload to private S3 → record the object key and the
findings in Neon → add every posting kept to the cumulative `postings` record.

Vocabulary is in `CONTEXT.md`, and it is worth reading first — in particular
**Job** means "a row in `jobs`, a thing that runs on a cadence" and never an
employment opportunity, which is a **Posting**. To a user a job is a
**Briefing**, and what one run of it produces is a **Brief**.

## Where it lives

| Stage                                        | Owner                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard — chat, documents, briefings       | `apps/dashboard/` (Next.js 16 App Router, Vercel)                                                                                                                                                                                   |
| Lambda entrypoint + hourly tick              | `apps/briefing-worker/src/` (`index.ts`, `run-tick.ts`)                                                                                                                                                                             |
| A run someone triggered from the UI          | `apps/briefing-worker/src/run-ad-hoc.ts`, asked for by `apps/dashboard/lib/briefing-runs/`                                                                                                                                          |
| One briefing run                             | `apps/briefing-worker/src/run-briefing.ts`                                                                                                                                                                                          |
| What `jobs.config` means                     | `packages/job-search/src/job-search-config.ts`                                                                                                                                                                                      |
| Words that rule a Posting out by its title   | `packages/job-search/src/title-exclusions.ts`, stored by `packages/db/src/posting-filters.ts`, enforced in `apps/briefing-worker/src/run-briefing.ts` and `packages/db/src/postings.ts`                                             |
| The named agents                             | `packages/agents/src/` — one `createX()` factory per module                                                                                                                                                                         |
| The scout↔writer contract                    | `packages/agents/src/findings.ts`                                                                                                                                                                                                   |
| The search-criteria contract                 | `packages/agents/src/criteria.ts`                                                                                                                                                                                                   |
| The posting↔resume match contract            | `packages/agents/src/match.ts`, produced by `match-assessor.ts`                                                                                                                                                                     |
| Scoring Postings against the resume          | `apps/dashboard/lib/postings/match-actions.ts`, driven by `apps/dashboard/components/jobs/postings/score-pending-matches.tsx`                                                                                                       |
| Proposing criteria from a resume             | `apps/dashboard/lib/jobs/suggest-criteria-actions.ts`, reading through `apps/dashboard/lib/cover-letters/candidate-background.ts`                                                                                                   |
| The tool catalog                             | `packages/agent-tools/src/` — one tool per module                                                                                                                                                                                   |
| Orchestrator graph, state, model             | `packages/agents-core/src/`                                                                                                                                                                                                         |
| Jobs, runs, artifacts                        | `packages/db/src/` (Prisma Client + domain helpers) and `packages/db/prisma/`                                                                                                                                                       |
| Every Posting ever found, and its status     | `packages/db/src/postings.ts`, projected from findings by `apps/briefing-worker/src/postings.ts`, read by `apps/dashboard/lib/postings/`                                                                                            |
| Adding a Posting by pasting its link         | `apps/dashboard/lib/postings/add-by-link-actions.ts`, over `@workspace/agents/board-fetch` first and `@workspace/agent-tools/page-extract` (then `page-extract-apify` on failure) + `@workspace/agents/posting-extractor` otherwise |
| S3 read/write                                | `packages/user-storage/src/` — extend `brief-store.ts` / `resume-store.ts` / `cover-letter-store.ts`, never import the AWS SDK elsewhere                                                                                            |
| Langfuse tracing                             | `packages/langfuse/src/`, wired in each runtime's entry point                                                                                                                                                                       |
| EventBridge schedule, bucket, IAM, lifecycle | `infra/aws/` (`briefing-worker.tf`, `user-storage.tf`, `vercel-dashboard.tf`)                                                                                                                                                       |

**There are three page fetchers, and none is a tool.**
`seek-search.ts`, `indeed-search.ts` and `linkedin-search.ts` each query one job
board's live inventory through its own Apify actor, over the shared runner in
`apify-search.ts` — which is machinery rather than a tool, and is what makes a
board an actor id, a request body and a field mapping instead of a fourth
implementation. `get_posting_details` reads back one advertisement the scout
already found, by id. `web-search.ts` is a general Tavily search, and `time.ts`
answers what the current time is. The whiteboard agent carries a separate canvas
tool set (`canvas.ts`) that mutates an in-memory board session rather than
reaching the network.

The fetchers exist for **adding a Posting by pasting its link**, and each is a
plain function: absent from `allTools`, carried by no agent, and asserted to be
both for the board and Tavily paths.

- `board-posting.ts` asks the board that issued the link for the advertisement
  behind it, through the same actor a search uses — SEEK and Indeed only, via a
  `byUrl` entry on their spec. **It skips the model entirely**: the board
  publishes `title`, `company`, `location` and the description as fields, so
  there is no reading to be done and nothing to get wrong. `board-fetch.ts` in
  `@workspace/agents` is where `boardForHost` and `postingId` meet it, because
  `agent-tools` may not depend on that package.
- `page-extract.ts` retrieves the page at an arbitrary URL via Tavily and is the
  first try for everything else — a Greenhouse link, a company careers page, and
  LinkedIn, whose actor takes search-results URLs and cannot be handed a job page.
- `page-extract-apify.ts` is the same general path's second try: Apify's
  Website Content Crawler, once, when Tavily returns `failed`. Board failures
  still do not chain here.

**No tool retrieves a URL**, which is the property that used to be stated as
"there is no fetch tool" — a fetcher in an agent's hands is a security surface,
and the four hazards are answered structurally rather than promised:

- **SSRF** — the retrieval is a POST to Tavily's `/extract` or to an Apify actor
  run, and _they_ fetch the page. This system never opens a socket to a host
  somebody typed into a form.
- **Redirect chains** — the fetcher's problem. One JSON request, one JSON reply.
- **Response size** — bounded at `MAX_PAGE_CHARS` before it can reach a model, as
  `posting-details.ts` bounds a description. On the board path nothing unbounded
  reaches a model at all.
- **Prompt injection** — the page reaches exactly one agent, the **Posting
  Extractor**, which has no tools, holds no CV and answers into a schema. This
  is the "separate agent that never sees the profile" the letter writer and the
  resume tailor each defer to in as many words. The board path has no agent in
  it, so the hazard does not arise.

The scout carries the three board tools plus `get_posting_details` and nothing
else; the dashboard's assistant carries `allTools`, which is `get_current_time`
and `web_search` — neither the board tools nor any fetcher are in it.

## Rules

- **S3 stays private.** Neon stores object keys only — never URLs, never blob
  content. The `artifacts.object_key` CHECK enforces it.
- **The title filter is enforced, and it is never silent.** A user's excluded
  title words are applied twice as a rule no model takes part in — the worker
  drops a matching posting between the hand-off and the writer, and the Postings
  table leaves out a matching row it already holds. Both ends read one rule
  (`normalizeTitle()` in `@workspace/job-search`, restated in SQL as the
  `postings.title_normalized` generated column). Because a filtered row is not
  there to be noticed, every place that removes one says how many: the table
  prints the count, the run report carries `excludedPostings`, and pasting a link
  the filter would hide is refused rather than added invisibly. Nothing is
  deleted — clearing the list brings every row back with its status intact.
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
  calls inside it. Its tools search, read what a search returned, and report;
  nothing reaches outside the run, so this is structural.
- **A Posting may arrive without a Run.** Pasting an advertisement's link adds
  one directly, so `postings.first_seen_run_id` and `last_seen_run_id` are
  nullable and NULL means "no Run has ever seen this". There is no `source`
  column. `recordLinkedPosting` is `ON CONFLICT DO NOTHING`, so a link may
  create a Posting and may never revise one — it cannot touch a status a person
  set, blank a Run's provenance, or overwrite a Run-written payload.
- **The scout never handles a URL.** A search returns two lines per posting
  against an **id**; the advertisement itself is read back by id with
  `get_posting_details`, and a reported posting names that id. The worker
  resolves it to the URL the board issued — see
  `apps/briefing-worker/src/resolve-postings.ts`, which records the seven
  production runs lost to a model retyping a LinkedIn URL slightly wrong. An id
  no search returned names nothing, so a fabricated posting cannot pass.
- **A dropped posting costs the posting, not the Run.** The brief is written
  from what survived, and the Run succeeds carrying an `unresolvedPostings`
  warning that names what was left out. A Run where _every_ reported posting is
  unaccounted for still fails: that is a scout reporting postings it never
  found.
- **A run with no successful search fails.** Well-formed findings that never
  touched a live search would produce a confident brief citing postings nobody
  looked up — worse than no brief.
- **A run never overwrites a Posting's status.** `recordPostings` upserts on
  `(user_id, posting_id)` and its `DO UPDATE SET` list omits `status` — the only
  column in the schema a person writes. That omission is the tracker; see
  `packages/db/README.md` §Schema notes.
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
    G --> T1[seek_search → Apify SEEK actor]
    G --> T2[indeed_search → Apify Indeed actor]
    G --> T3[linkedin_search → Apify LinkedIn actor]
    T1 --> X1[seek.com.au live listings]
    T2 --> X2[indeed.com live listings]
    T3 --> X3[linkedin.com live listings]
    T1 --> C[Posting catalog — id → posting, one per run]
    T2 --> C
    T3 --> C
    C --> G2[get_posting_details — the shortlist, in full]
    G2 --> G
    G -->|submit_findings, ids resolved against the catalog| L[Brief writer agent]
    L --> Z[Markdown]
    Z --> U[Upload to private S3]
    U --> V[(S3 bucket — markdown briefs)]
    V --> W[Record object key in artifacts]
    W --> K[Keep findings on the run row]
    K --> PT[Upsert every posting into postings, statuses untouched]
    F --> CW[CloudWatch logs & metrics]
    F -.->|optional, keys permitting| LF[Langfuse trace: generate-briefing]
```

A Run is no longer the only way a Posting arrives. Pasting an advertisement's
link on `/jobs` adds one directly — no Run, no Briefing, and both run columns
NULL. Which retrieval answers depends on who issued the link:

```mermaid
flowchart TD
    U[/jobs — paste a link/] --> ID[postingId of the pasted URL]
    ID -->|already tracked| STOP[Say so, spend nothing]
    ID --> B{SEEK or Indeed?}
    B -->|yes| BF[The board's actor, by startUrls]
    BF -->|not that advertisement| SAY2[Say so — no second retrieval]
    BF --> V2[Validated against the schema]
    B -->|no| EX[extractPage — Tavily fetches the page]
    EX -->|failed| AP[extractPageViaApify — Website Content Crawler]
    EX -->|ok| PE[Posting Extractor — no tools, no CV]
    AP -->|ok| PE
    AP -->|failed| SAY3[Surface the failure]
    PE -->|not a job advertisement| SAY[Say what the page was]
    PE --> V2
    V2 --> PT2[(postings — no Run at either end)]
```

The URL never reaches a model, and never comes back from one: it is the user's,
and it is attached to the validated answer afterwards. The board's own canonical
link is used only to check that the actor answered about the advertisement that
was asked for, and is then discarded. A board that fails is **not** followed by a
second retrieval — the board path has already spent its clock, and the general
fetcher is the path least likely to get past the board that just refused. On the
general path, Tavily is tried first and Apify's Website Content Crawler once if
Tavily cannot read the page; both still delegate the fetch, so this process never
opens a socket to the host the user named. From there a link-added Posting is an
ordinary Posting — the same table, the same status, the same two documents.

What a person then does with a **Posting** happens entirely in the dashboard, off
the row rather than off a Run — two documents, both addressed by
`(user, Posting)`, both written from the newest **Document** labelled Resume:

```mermaid
flowchart TD
    PT[(postings — payload, last_seen_run_id)] --> BR[/jobs — expanded posting/]
    PT2[(postings — added by link, no Run)] --> BR
    DOC[(S3 — resumes: the user's uploaded CV)] --> BG[loadCandidateBackground]
    BG --> BR
    BR -->|Draft cover letter| LW[Letter Writer]
    BR -->|Generate tailored resume| RT[Resume Tailor]
    LW --> CL[(S3 — cover-letters/postingId.md)]
    RT --> TR[(S3 — tailored-resumes/postingId.md)]
    TR --> PDF[PDF rendered in the browser]
```

Both agents hold the CV and read the advertisement verbatim, so both have
`tools: []`; neither writes a database row. The difference is what they produce
from the CV: the **Letter Writer** writes _about_ it and leaves a
`[bracketed placeholder]` wherever a fact was not supplied, while the **Resume
Tailor** rewrites _it_ and may leave nothing out of nothing — every line it emits
must have a counterpart in the source.

Opening `/jobs` at all starts a third use of the same CV, before anybody clicks
anything: every **Posting** not yet scored against the current resume is given a
**Match**, in bounded rounds, until a round writes nothing.

```mermaid
flowchart TD
    BR2[/jobs — mounted/] --> A[scorePendingMatches]
    BG2[loadCandidateBackground] --> A
    A -->|no readable CV| SAY[Say so, build no model]
    A --> Q[listUnmatchedPostingIds — match_resume_id is not the current one]
    Q --> MA[Match Assessor — no tools, one call per posting]
    MA --> W[recordPostingMatch — five columns, one statement]
    W --> PT3[(postings — match_score, sortable)]
    W -->|a round that scored nothing| STOP[Stop, whatever the count says]
```

**This runs in the dashboard because it cannot run in the worker.** The Lambda's
role grants the `briefs` shelf and nothing else, and
`infra/aws/tests/vercel_dashboard.tftest.hcl` asserts the two roles' grants stay
disjoint — so the process that finds an advertisement structurally cannot read
the CV it would be scored against. The cost is stated rather than hidden: a
briefing that runs overnight leaves its Postings unscored until somebody opens
the page.

The loop stops on **a round that scored nothing**, not on a backlog of zero. A
Posting that fails scoring stays unscored and is therefore picked again by the
very next round, so a count that never reaches zero would spin forever.

## Not built yet

The pipeline above runs end to end. These are the parts of the intended product
it still lacks. Most began as whole gaps and have since been partly closed —
each entry below leads with what is _missing_, so **a solid edge is a path that
exists and a dotted one is still the gap**:

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

- **Nothing turns a document into criteria with nobody watching.** Extraction
  itself is built: the **Profile Extractor**
  (`packages/agents/src/profile-extractor.ts`) reads the newest **Document**
  labelled `resume` and _proposes_ **Search Criteria**, validated on shape by
  `SearchCriteriaSchema` (`packages/agents/src/criteria.ts`), behind **Suggest
  from my resume** on the new-briefing form
  (`apps/dashboard/lib/jobs/suggest-criteria-actions.ts`). It reads through
  `loadCandidateBackground()` rather than adding a document picker, deliberately
  — "which document is my resume" has to mean one thing across the app, or a
  **Cover Letter** and a **Briefing** end up drawn from different files with
  nothing saying so.

  What is missing is anything that closes the loop without a person in it. The
  extractor proposes into the form's fields, the user edits them, and
  `jobs.config` is written by the ordinary create action on Create. The
  suggestion persists nothing — which is why the action calls no `refresh()`,
  having invalidated nothing — and no Postgres row points at an upload:
  `artifacts.run_id` is `NOT NULL` and references `runs`, so nothing records
  which Document a briefing's criteria came out of. `.doc`, `.odt` and `.rtf`
  also still upload with no parser and are refused by name; `.md`, `.txt`, PDF
  and DOCX are read by `profile-text.ts` (#86).

- **Fan-out across several scouts, with merge and rank.** One scout runs today.
  Fanning out replaces what produces `Findings` and leaves everything downstream
  of it alone.
- **Sending a cover letter.** Everything short of delivery is built, under #77.
  Drafting (#84): a Draft button on each **Posting** on `/jobs` runs the
  **Letter Writer** over the advertisement stored on that Posting's row —
  `postings.payload`, re-read server-side, since the page no longer holds a
  Run's findings to draft from — and stores the result at
  `prod/{userId}/cover-letters/{postingId}.md`, keyed on the Posting so a
  redraft overwrites one object. The letter's key and the row's identity are the
  same `postingId()` value, which is what keeps a stored letter attached to the
  Posting it was written for. Listing and downloading (#85):
  `cover-letter-rows.ts` issues one `ListObjectsV2` via `CoverLetterStore.list`
  rather than a `HeadObject` per visible Posting, and
  `/api/cover-letters/{postingId}` hands the Markdown back as a file. **Letter
  Instructions** — a per-user row in
  `cover_letter_instructions`, edited from `/jobs/letters` and composed onto the
  writer's prompt by `coverLetterSystemPrompt()` — make tone and structure
  settable, with an optional example letter fenced as a style reference and
  never as a source of facts. Editing: **Edit letter** opens the stored Markdown
  as rich text in `FileEditorDialog` and **Save** writes it back over the same
  object, carrying `drafted-at` and provenance across because an edit is not a
  drafting. A save refuses when no letter exists at that address, which keeps an
  action that _does_ take letter text from a form out of the business of
  creating one. Delivery has no code at all.

- **A viewer for the Brief itself, and that gap is structural rather than
  merely unbuilt.** The dashboard's IAM grants are `prod:resumes`,
  `prod:cover-letters` and `prod:tailored-resumes` while a brief lives under
  `prod:briefs`, so the app cannot read one without an infrastructure change.
  Neither the cover-letter grant nor the tailored-resume one widened it here —
  `tests/vercel_dashboard.tftest.hcl` asserts the exact key set, so a third kind
  had to be argued for in that test, and it asserts separately that the
  dashboard's and the worker's grants stay disjoint.

  What `/jobs` does show is what the runs have _found_ — every **Posting**
  any of this user's briefings has ever turned up, read out of the `postings`
  table by `lib/postings/list-postings.ts` as a sorted, server-paginated table,
  each row carrying the **Posting Status** its owner set and opening its full
  detail in a dialog. It no longer reads one Run's `runs.findings`, so a Posting
  the next Run does not re-find stays on the page rather than vanishing
  overnight. Above the table, `components/jobs/postings/briefing-strip.tsx` renders
  one line per briefing from `run-activity.ts` — its most recent Run whatever
  became of it, running, failed, or too long in `running` to still be believed —
  and carries that briefing's **Run now** button, which is what makes the line
  worth watching. That is a status line and not a history: nothing lists more
  than one Run per briefing and nothing can cancel one. There is no
  "latest artifact for this job" helper either — once a run can write more than
  one artifact, that query stops being well defined, and the briefings page
  never needed it: briefs live under `prod:briefs`, which the dashboard cannot
  read.

## Infrastructure

- Frontend and application on Vercel; database is Neon Postgres, reached through
  Prisma Client over a `pg` driver adapter.
- The scheduled worker runs on AWS Lambda, triggered hourly by EventBridge
  Scheduler. The tick is the same for every job, so a job's own cadence is a row
  in Postgres rather than anything in Terraform.
- S3 privately stores generated markdown briefs, uploaded documents, drafted
  cover letters and tailored resumes. IAM is least-privilege and bounded by a
  permissions boundary; grants are per environment and kind, so the worker holds
  `prod:briefs` and the dashboard's Vercel OIDC role holds `prod:resumes`,
  `prod:cover-letters` and `prod:tailored-resumes`, and the two roles' grants are
  disjoint — the dashboard cannot forge or delete a briefing, and the worker
  cannot touch anything a person wrote or generated.
- Secrets are AWS Secrets Manager shells whose values are set by hand —
  Terraform provisions containers it can never read.
- All AWS infrastructure is Terraform under `infra/aws/`, which Turborepo does
  not cover. CloudWatch provides logs, metrics and failure alarms.
- Langfuse receives one trace per agent run when its keys are present:
  `generate-briefing` from the worker, and `chat-response`, `cover-letter`,
  `posting-extract`, `search-criteria`, `tailored-resume` and `whiteboard-turn`
  from the dashboard.
  All retain full prompts, tool I/O and outputs by design — which for the
  cover-letter, search-criteria and tailored-resume traces means the candidate's
  CV, so the keys are what decides whether it leaves the machine.

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
