# Cover Letter Agent — staged plan

## Context

`OVERVIEW.md` §Not built yet lists **Cover letters** as one of the intended
parts of the product that does not exist. Today the pipeline is
`config → scout ⇢ Findings → Brief Writer → markdown → S3 → artifacts row`:
two agents joined by plain TypeScript, with `parseFindings()` validating the
hand-off. The output is a Briefing the user cannot yet read anywhere.

The feature to add is **one cover letter per Posting** — a first-person draft
for a specific open advertisement, written in the candidate's voice. That last
clause is what makes this different from every agent already here. The Brief
Writer summarises what a search found; a cover letter *asserts things about a
person* to a stranger. An invented "I led the migration of…" is not a thin
brief, it is a lie attributed to the user. So the governing constraint is the
same one that made the Brief Writer tool-less, applied harder.

Intended outcome: from the dashboard, the user sees the Postings a Run found
and can draft a cover letter for any one of them; the draft is stored privately
per user and is re-drafted idempotently.

---

## Where the code contradicts the brief

Everything the brief asserts about the code is accurate. Three things it did
not state, which change the plan's shape:

1. **The dashboard's IAM grant is `prod:resumes` and nothing else**, asserted
   exactly in `infra/aws/tests/vercel_dashboard.tftest.hcl:80`
   (`keys(...) == ["prod:resumes"]`), with a second assertion that the
   dashboard's and the worker's grants are disjoint. So an on-demand,
   dashboard-side letter **cannot read anything the worker wrote** without an
   infra change and a test change. This is the single biggest cost in the plan
   and it is invisible from the TypeScript.
2. **The per-kind IAM policy grants read *and* write *and* delete together** —
   `modules/user-storage/main.tf`'s `kind_access`. There is no read-only
   variant, so "let the dashboard see the Findings" is currently spelled "let
   the dashboard overwrite the Findings".
3. **`RunStore.startAdHoc(jobId)` exists**, so an ad-hoc `runs` row *is*
   reachable — the on-demand path is not blocked on the schema. It is rejected
   below for semantic reasons, not because it is impossible.

Minor doc drift, worth fixing in passing: `OVERVIEW.md:24` labels
`packages/agent-tools/src/` "Search and fetch tools". There is no fetch tool —
only `web-search.ts` and `time.ts`. This plan does not add one either, so the
line should be corrected to "Search tools" rather than left reading as a
promise.

---

## The six decisions

### 1. Where the substance comes from

**Decision:** the candidate's side comes from **a document the user has already
uploaded**, read verbatim through `ResumeStore`, restricted in v1 to `.md` and
`.txt`. The Posting's side comes from **the `Posting` record, verbatim, and
nothing else**. `PostingSchema` is not extended, and no page is fetched.

Why not the alternatives:

- **Extending `PostingSchema` with requirements is the worst option available.**
  The Scout only ever sees Tavily snippets — `title`, `url`, `content`,
  `published_date` — because it has no fetch tool. Asking it for a requirements
  list asks it to invent one, in the exact schema whose stated purpose is that
  "a URL the scout assembled rather than received is a fabrication, and the
  schema rejects it". It would also change the contract every existing brief is
  written against.
- **A fetch tool is the right eventual answer and the wrong first one.** It is a
  real security surface (SSRF, redirect chains, response size, and prompt
  injection from a page the model then acts on), and it must not live on the
  agent that holds the candidate's CV — see decision 2. Staged to §Stage 4.
- **A user-typed profile field** would need `JobStore.updateConfig()`, which
  does not exist (`jobs.config` is written only by `create()`), plus a form and
  a third copy of a schema `search-criteria.ts` already apologises for
  duplicating. More new surface than reading a file the user already uploaded,
  for weaker substance.
- **Reading the uploaded document is nearly free where the letter is drafted.**
  The dashboard already holds `prod:resumes`, already has an upload UI, and
  `lib/documents/list-documents.ts` already `head()`s every object and returns
  `documentType` — so "the newest document the user labelled `resume`" is one
  existing function call away.

**What the letters will read like, honestly.** The candidate half will be
genuinely specific: it is the user's own CV text, quoted and reorganised. The
Posting half will be thin — the agent knows a title, a company, a location, two
or three sentences of `summary` and one sentence of `matchReason` written by a
different model. So the "why I fit" paragraph reasons from a summary rather than
from requirements, and will read as competent but non-specific about the role.
Where the letter needs a fact nobody supplied — a start date, a salary
expectation, a named recipient — the prompt requires a literal
`[bracketed placeholder]` rather than a plausible invention. **A visible gap is
the correct output.** The deliverable is a strong first draft the user edits,
not a submittable letter, and the UI should say so.

**The `.md`/`.txt` restriction is the honest cost.** Most people upload a PDF.
v1 will tell such a user, in the UI, that it cannot read their CV yet. Widening
this is Stage 4; it is a parser dependency, not a design change.

### 2. Tool set — a security decision

**Decision: `tools: []`. The same structural guarantee as the Brief Writer, for
a stronger reason.**

- The agent cannot search, so it cannot supplement a thin Posting with a company
  detail it half-remembers. Everything it says about the role came from a record
  a validated schema produced.
- It cannot write anywhere, so storing the letter stays the caller's job.
- **The decisive one: it holds the candidate's CV text in its context.** Giving
  this particular agent any outbound tool creates an exfiltration path — a
  Posting summary is attacker-influenced text (it originates from a web page a
  search returned), and an agent that can both read a CV and issue a request can
  be induced to put one inside the other. Tool-lessness is not a quality
  preference here, it is the containment.

The corollary binds Stage 4: **when a page-fetch tool is added, it goes on a
separate posting-reader agent that never sees the profile**, and that agent's
output is validated data handed to the tool-less writer — the same
`Scout → parseFindings → Writer` shape, for the same reason.

### 3. When it runs — on demand

**Decision: on demand, from the dashboard. Not inside the Run.**

Costing the in-run option against `maxPostings` (default 8, max 25):

- The letter agent has no tools, so each letter is exactly **one model call** —
  but a long-output one (~350 words). A Run today is Scout (3–5 calls) + Writer
  (1) ≈ 5–6 calls producing one document. At the default it becomes ~14 calls
  producing **nine** documents; at the ceiling, ~31 calls and **26** documents.
  Output tokens, which dominate cost here, grow roughly 8–25×.
- On a daily cadence that is ~2,900 letters a year, for a product where
  `ArtifactStore.latestForJob()` still has no caller — nobody has read a single
  brief through the UI yet. Generating 8 letters per day for an unread digest is
  the clearest waste available.
- `runTick` is sequential in one Lambda invocation. Eight extra sequential model
  calls per due job push a tick toward its timeout for no user-visible gain.
- It multiplies the failure surface of the product by the failure surface of an
  accessory: eight more chances to break a Run that would otherwise succeed.

The honest cost of choosing on-demand: **there is no UI showing a Run's output
at all**, so this feature has to build one. That is Stage 2 and it is real work,
not a footnote. It is also work `OVERVIEW.md` already wants done.

### 4. Storage and addressing

**Decision: a new object kind, `cover-letters`. Key:
`{environment}/{userId}/cover-letters/{postingId}.md` — flat, like `resumes`.**

Rejecting the reuse options:

- **`briefs`** — the dashboard holds no `:briefs` grant, and the per-kind policy
  is read/write/delete, so granting it would let the dashboard rewrite or delete
  a Briefing. `vercel_dashboard.tftest.hcl:81` exists to fail exactly that edit.
- **`resumes`** — mechanically it would work (`.md` is on its allowlist, the
  dashboard already has the grant), and it costs three things. Retention becomes
  "never expire" by inheritance rather than by decision. Every generated draft
  appears in `/documents` among the user's own files. And it breaks the
  vocabulary: `CONTEXT.md` defines a **Document** as "something the user
  uploaded themselves", and the `documentType: "cover-letter"` label would stop
  distinguishing a letter the user wrote from one the machine wrote. In this
  repo that last one is a real reason, not a stylistic one.

What a new kind obliges, in full — omitting either half is the failure
`kinds.ts` and `OVERVIEW.md` both warn about (no retention, and writes 403 for
want of the per-kind grant):

- `packages/user-storage/src/kinds.ts`: `cover-letters: { contentTypes: { ".md": "text/markdown; charset=utf-8" }, disposition: "inline" }`.
- `infra/aws/modules/user-storage/variables.tf` → `object_kinds`:
  `cover-letters = { expiration_days = null, noncurrent_version_expiration_days = 365 }` —
  the `resumes` posture, not the `briefs` one. A letter is written in the user's
  voice and they may have relied on it; auto-deleting it is data loss, not
  housekeeping.
- `infra/aws/vercel-dashboard.tf`: widen the write filter to
  `:resumes` **and** `:cover-letters`. Kind names are validated
  `^[a-z][a-z0-9-]*$`, so the dash is fine, and it satisfies `SEGMENT_PATTERN`.

**The per-Posting id.** `Posting` has no id field and must not gain one — a
model-generated id is a fabrication surface and would not be stable across Runs.
Instead derive it: `postingId(posting) = sha256(normalized url).slice(0, 16)`
hex, added to `packages/agents/src/findings.ts` beside the contract it is a
property of. Hex is `[a-z0-9]`, so it satisfies `SEGMENT_PATTERN` outright. The
URL is the one field the schema guarantees was *copied and not composed*, which
makes it the only honest identity a Posting has.

The idempotency this buys is the one that matters for an on-demand action: the
unit is **(user, posting)**, not (user, run). Re-drafting the same Posting
overwrites one object — versioning is on, so the previous draft survives under
the 365-day noncurrent rule. Putting the run id in the key instead would mean a
user who clicks twice owns two objects, one of them orphaned.

Provenance rides in S3 metadata, not in the key: `drafted-at`, `posting-url`,
`posting-company`, `posting-title`, `source-run-id`. **All of these must go
through the same sanitisation `cleanFilename` applies** — metadata values travel
in HTTP headers, and `company`/`title` are model-copied text that can carry
non-ASCII or a newline. This is a live header-injection path, not a formality.

### 5. Recording — letters get no `artifacts` row

First, confirming the mechanics the brief asked about: **several artifacts rows
against one `run_id` does hold.** `artifacts_run_id_idx` is non-unique, only
`object_key` is `UNIQUE`, and `forRun()` returns an array. So the in-run variant
was available; it is rejected on the grounds in decision 3, not by the schema.

**Decision: a cover letter is recorded in S3 and nowhere else.**

- `artifacts.run_id` is `NOT NULL`. An on-demand letter has no Run —
  `CONTEXT.md` defines a **Run** as "one execution of a job", and drafting a
  letter is not an execution of a briefing job. Minting an ad-hoc `runs` row per
  click (which `startAdHoc` would happily do) pollutes `runs.recent(jobId)` —
  the dashboard's job detail view — with rows that are not briefings.
- The key is fully derivable from `(userId, postingId)`, so a row buys no
  addressability that `CoverLetterStore.list(userId)` does not already give.
- **The precedent is already in the repo and already documented.** Uploaded
  documents have no Postgres row for exactly this reason —
  `OVERVIEW.md`: "S3 is the only record of an upload — `artifacts` has no row
  shape for one, because `artifacts.run_id` is NOT NULL". The same sentence
  applies verbatim to an on-demand letter.

**What the dashboard queries.** For letters: nothing in Postgres —
`CoverLetterStore.list(userId)`, plus a `head()` per item for display metadata.
That is the same deliberate N+1 `list-documents.ts` already documents and
accepts. For Postings: `runs.recent(jobId)` → first `succeeded` →
`artifacts.forRun(run.id)` → pick by `parseObjectKey(key).kind === "findings"`.

⚠️ **`ArtifactStore.latestForJob()` becomes ambiguous and must not be used.**
It orders by `r.started_at desc, a.created_at desc` and returns one row; once a
Run writes two artifacts it returns whichever was recorded last. It has no
caller today, which is why this is a trap rather than a bug. The path above is
kind-explicit and needs **no change to `@workspace/db` at all**.

### 6. Failure semantics

The precedent is *"a run with no successful search fails"*, and its reasoning is
worth stating precisely before transplanting it: the guarded failure mode is
**silent fabrication**, not absence. A brief citing postings nobody looked up
looks perfect and is worthless; a missing brief is loud. The rule follows from
the failure being invisible, not from the thing being important.

Applied here, that reasoning points three ways:

1. **A failed letter never fails a Run** — under this plan letters do not run
   inside one, and even in the in-run variant it should not have. A missing
   letter is a loud absence: the user clicked and got an error. The Briefing is
   the product and an accessory must not sink it.
2. **The Findings artifact (Stage 2) is non-fatal.** It is written and recorded
   *after* the brief, inside a `try/catch`; a failure adds a warning to the
   `SuccessReport` and `runTick` passes it to `RunStore.finish(runId, warnings)`.
   `0001_init.sql` already provides for this: *"Succeeded with warnings is
   `status = 'succeeded'` with a non-empty failure payload, not a fourth
   status."* A Run that produced a Briefing succeeded, whatever happened to the
   accessory.
3. **The transplant that does bite is inside the letter action.** A letter
   drafted with no candidate substance would be fabricated wholesale — the exact
   silent failure the search-count check exists to catch. So
   `assertDraftable()` **refuses before the model is called** when the profile is
   absent or under `MIN_BACKGROUND_CHARS` (200). It also refuses above
   `MAX_BACKGROUND_CHARS` (20,000) rather than truncating: a letter written from
   half a CV with nothing saying so is the same silent failure wearing different
   clothes.

---

## Stages

### Stage 1 — the agent and its contract (no storage, no DB, no dashboard, no infra)

The smallest shippable slice, and deliberately the one that answers the riskiest
question before anything is built around it: *are the letters any good with only
a Posting summary and a CV?*

**Added**

| File | Role |
| --- | --- |
| `packages/agents/src/cover-letter.ts` | The contract, beside `findings.ts` and for the same reason — it belongs to neither side. `CandidateProfileSchema` (`name?`, `background`), `CoverLetterRequestSchema` (`posting: PostingSchema`, `profile`), `assertDraftable()`, `toCoverLetterPrompt()` (pure), `MIN_/MAX_BACKGROUND_CHARS`. |
| `packages/agents/src/cover-letter-writer.ts` | `COVER_LETTER_WRITER_SYSTEM_PROMPT`, `CreateCoverLetterWriterOptions = Omit<CreateAgentOptions, "tools">`, `createCoverLetterWriter()` → `createAgent({ ...rest, systemPrompt, tools: [] })`. One agent per module, a `createX()` factory, never an instance. |
| `apps/briefing-worker/src/dev/letter.ts` | A `tsx` CLI: `--findings <file.json> --profile <file.(md\|txt)> --posting <n>` → letter on disk. Lives here because this is where the harness machinery already is and nothing under `dev/` reaches `dist/` (the esbuild entry is `src/index.ts` alone). `@workspace/agents` has no runner of its own. |

**Changed**

- `packages/agents/src/findings.ts` — add `postingId(posting: Posting): string`.
  Uses `node:crypto`; the package already carries `@types/node`.
- `packages/agents/src/index.ts` — export the new names.
- `packages/agents/package.json` + a `tsconfig.test.json` — see testing below.

**Prompt requirements** (the security properties, written down):
first person as the candidate; every claim about the candidate traceable to the
background text — no employer, year count, metric or technology that is not in
it; everything about the role from the Posting record only; a
`[bracketed placeholder]` wherever a fact was not supplied, never a plausible
invention; `Dear Hiring Team` unless the Posting names a recipient; 250–350
words, markdown, no code fence, no preamble.

**Testing, without an API key.** `@workspace/agents` has no test setup —
**adding one costs**, per `CLAUDE.md`, four things and no more: `vitest` as a
devDependency, a `test` script, a `tsconfig.test.json` with `noEmit` covering
`src/**/*.test.ts`, and that same glob excluded from `tsconfig.json` so tests
never reach `dist/`; `typecheck` then runs both. The `test` task already exists
in `turbo.json`. Tests:

- `toCoverLetterPrompt()` carries the Posting URL and the background verbatim.
- `assertDraftable()` rejects absent, short and oversized backgrounds.
- `postingId()` is stable, and matches `SEGMENT_PATTERN` from
  `@workspace/user-storage/keys`.
- **The tool set is asserted structurally**: drive `createCoverLetterWriter({ model })`
  with a fake `ChatModelLike` whose `bindTools(tools)` records its argument, and
  assert it received `[]`. `ChatModelLike` is structural precisely so this works
  with no key.

### Stage 2 — Findings become durable and visible

Nothing about letters. This is the surface the on-demand choice obliges, and it
is also `OVERVIEW.md`'s "Dashboard views a brief", one step short.

**Storage**

- `packages/user-storage/src/kinds.ts` — add `findings` (`.json` →
  `application/json`, `inline`).
- `packages/user-storage/src/findings-store.ts` — a facade mirroring
  `brief-store.ts` exactly: date-partitioned on the **occurrence**, keyed by run
  id → `{env}/{userId}/findings/{YYYY}/{MM}/{DD}/{runId}.json`. Same idempotency
  property as a brief, for the same reason. Export from `index.ts`.

**Infrastructure** — the expensive part.

- `modules/user-storage/variables.tf` → `object_kinds`:
  `findings = { expiration_days = 90, noncurrent_version_expiration_days = 30 }`.
  Shorter than a brief: Findings are the input record, useful for re-drafting
  from a recent Run, not for a year.
- `modules/user-storage/main.tf` — **a new read-only per-kind policy**
  (`aws_iam_policy.kind_read`: `s3:GetObject`, `s3:GetObjectTagging`, and
  `s3:ListBucket` under the same `s3:prefix` condition), plus a
  `kind_read_policy_arns` output. Needed because the existing `kind_access`
  policy is read/write/delete, so "the dashboard can see Findings" would
  otherwise mean "the dashboard can overwrite what a Run found". Reusable — a
  future brief-viewing page wants `prod:briefs` read-only on the same shape.
- `briefing-worker.tf` — widen the write filter to `:briefs` **or**
  `:findings`.
- `vercel-dashboard.tf` — a **separate** attachment resource
  (`vercel_dashboard_user_storage_read`) taking `:findings` from
  `kind_read_policy_arns`. Separate on purpose: the existing disjointness
  assertion compares the two *write* attachments and stays literally true,
  gaining the sharper meaning "no write grant is shared".
- `tests/user_storage.tftest.hcl` — assert `cover-letters` has no `expiration`
  block at all (the `resumes` assertion's shape), and that `prod:findings` exists
  as a key.
- `tests/vercel_dashboard.tftest.hcl` — the `== ["prod:resumes"]` assertion
  becomes `== ["prod:cover-letters", "prod:resumes"]` with a restated reason, and
  a new assertion pins the read attachment to exactly `["prod:findings"]`.

**Worker**

- `run-briefing.ts` — after the brief's `upload` and `record` steps, a
  `findings` step: serialise the validated `Findings`, `findings.put(...)`,
  `artifacts.record(...)`. Wrapped so a failure adds `warnings?: string[]` to
  `SuccessReport` rather than throwing. `runTick` passes it to
  `db.runs.finish(slot.runId, warnings)`.
- `index.ts` — construct `createFindingsStore(createS3UserObjectStore())`
  alongside the brief store; `runTick`/`runBriefing` take it as a parameter, so
  nothing AWS-shaped leaves `index.ts`.
- `dev/stores.ts` — nothing to change; `createDirectoryObjectStore` is at the
  `UserObjectStore` layer, so the real `createFindingsStore` composes on top and
  the harness writes the JSON beside the markdown for free.

**Dashboard**

- `app/(app)/briefings/page.tsx` (+ `lib/nav.ts` entry) — **Briefings**, the
  vocabulary-correct name. `force-dynamic`, `maxDuration = 30`, its own
  `getCurrentUser()` and redirects (the layout's call is for the sidebar, not
  the gate). Latest `succeeded` Run per job → `artifacts.forRun()` → the
  `findings` key by `parseObjectKey` → `FindingsSchema.parse` → a list of
  Postings.
- `lib/briefings/latest-findings.ts` — that resolution as a pure-ish function
  over injected `Db` and `FindingsStore`, so it is testable.

**Testing** — `@workspace/user-storage` and `@workspace/briefing-worker` both
already have vitest. Key shape and occurrence-partitioning in the store; in
`run-briefing.test.ts`, that the Findings artifact is recorded after the brief
and that a throwing findings store yields `outcome: "success"` with a warning.
`terraform -chdir=infra/aws test` needs no credentials — run `init` first.

### Stage 3 — on-demand drafting

**Storage**

- `kinds.ts` + `cover-letter-store.ts` + `object_kinds` + the `vercel-dashboard.tf`
  write filter, exactly as specified in decision 4.

**Dashboard**

| File | Role |
| --- | --- |
| `lib/cover-letters/cover-letter-actions.ts` | `createCoverLetterActions(deps)`. **Imports nothing from Next.** Deps: `getUser`, `getResumes`, `getCoverLetters`, `getFindings`, `getDb`, `createWriter?`. |
| `lib/cover-letters/profile.ts` | `readProfile(userId, resumes)` — `listDocuments()` → newest `documentType === "resume"` with `.md`/`.txt` → `resumes.get()` → decode → `assertDraftable`. Returns a discriminated result, never throws for the expected "no readable CV" case. |
| `lib/cover-letters/agent.ts` | `CoverLetterAgentLike { invoke(input): Promise<{ messages: BaseMessage[] }> }` — the narrow structural seam, mirroring `AgentLike` in the worker. With zero tools the graph is one model call, so `invoke` suffices and `run-agent.ts` is not needed (apps do not depend on apps; the small duplication is noted in the file, as `search-criteria.ts` notes its own). |
| `app/(app)/briefings/actions.ts` | `"use server"`, thin wrapper, `refresh()` on success. |
| `components/briefings/*` | A per-Posting draft button and a letters list. |

**The action's two non-obvious rules**, both worth stating in the file:

- **The form carries `runId` and `postingId` only — never the Posting itself.**
  The Posting is re-read server-side from the Findings artifact and matched by
  `postingId`. Taking it from the form would let a caller put arbitrary text into
  a stored document and would destroy the "URLs are copied, never composed"
  guarantee at the last step of the chain that maintains it.
- **`runId` arrives from a form, so ownership is checked explicitly**:
  `runs.get(runId)` → `jobs.get(run.jobId)` → `job.userId === caller.userId`.
  The S3 key is then built from the *session's* `userId`, never from anything in
  the form — the same posture as `document-actions.ts`, which is why
  `assertSegment()` is a second line of defence rather than the only one.

Order of operations mirrors the worker: write the object, then (here) nothing —
there is no row, per decision 5.

**Testing** — `@workspace/dashboard` already has vitest, and nothing under
`lib/cover-letters/` imports Next, which is what makes it reachable. Fake
stores, a fake `Db`, and a fake agent returning an `AIMessage`. Cases: not
signed in; signed in but the Run belongs to another user's job; no readable CV;
`postingId` not present in the Findings; success writes
`.../cover-letters/{postingId}.md`; a redraft writes the same key; a
form-supplied posting body is ignored.

### Stage 4 — better substance (not scheduled)

Two independent widenings, in this order:

1. **Wider profile formats** — PDF/DOCX text extraction, a parser dependency in
   the dashboard. Removes the `.md`/`.txt` restriction, changes no interface.
2. **A posting-reader agent** — a new `packages/agent-tools/src/fetch-page.ts`
   (scheme allowlist, redirect and size limits, no private address ranges) and a
   `packages/agents/src/posting-reader.ts` that turns a Posting URL into a
   validated requirements record. Handed to the tool-less writer as data.
   **The fetch tool never goes on the letter writer** — see decision 2.

---

## Verification

```bash
pnpm build                                   # ordered by Turbo's ^build
pnpm typecheck                               # both halves in the emitting packages
pnpm test                                    # agents (new), user-storage, dashboard, worker
terraform -chdir=infra/aws fmt -recursive -check
terraform -chdir=infra/aws init -backend=false && terraform -chdir=infra/aws validate
terraform -chdir=infra/aws test               # mocked plan, no credentials
```

End to end, in order:

1. **Stage 1, with a key** — `pnpm --filter=@workspace/briefing-worker letter
   --findings ./.briefings/<run>.json --profile ./cv.md --posting 1`. Read the
   letter. This is the go/no-go for the whole feature.
2. **Stage 2 locally** — `pnpm --filter=@workspace/briefing-worker watch
   --config ./criteria.json` and confirm a `findings/…json` lands beside the
   markdown under `.briefings/`, with no AWS credentials involved.
3. **Stage 2 deployed** — after `terraform apply`, one real tick; check
   `artifacts.forRun()` returns two rows for the Run, and `/briefings` renders
   the Postings.
4. **Stage 3** — draft a letter from `/briefings`; confirm the object key,
   confirm a second draft of the same Posting overwrites rather than adds
   (S3 shows two versions, one current), and confirm the action refuses when no
   `.md`/`.txt` document is labelled `resume`.

---

## Open questions

1. Is "upload your CV as `.md` or `.txt`" acceptable for v1, or must PDF work on
   day one (moving Stage 4.1 ahead of Stage 3)?
2. Findings in S3 as a new kind (chosen — infra + two test edits) or
   `runs.findings jsonb` (one migration, zero infra)? I chose S3 on
   `0001_init.sql`'s stated organising rule and `OVERVIEW.md`'s "Neon stores
   object keys only", but the Postgres route is roughly half the work.
3. Read-only per-kind IAM policy for the dashboard's Findings grant (chosen), or
   is the existing read/write policy acceptable and the disjointness assertion
   simply relaxed?
4. Cover-letter retention: never expire, like `resumes` (chosen), or 365 days,
   like `briefs`?
5. Is `/briefings` the right route and nav entry, or should Postings appear
   under an existing section?
6. Re-drafting the same Posting overwrites the previous letter. Correct, or
   should each draft be kept as a separate object?

## Deliberately not building

- **A page-fetch tool, and any change to `PostingSchema`.** Both are the right
  eventual answer to thin Posting substance; neither is safe or cheap to add in
  the same change as an agent holding the candidate's CV.
- **Profile extraction.** `jobs.config` stays hand-written; this feature reads a
  document directly and writes nothing back to the search criteria.
- **In-run letter generation.** Costed in decision 3.
- **An `artifacts` row per letter, and any ad-hoc `runs` row.** Decision 5.
- **PDF/DOCX text extraction.** Stage 4.
- **Editing, regenerating with instructions, tone selection, or sending.** A
  letter is drafted, stored, downloaded. Nothing more.
- **`JobStore.updateConfig()`** and a search-criteria edit form — adjacent
  missing features this change does not need.
- **A brief-viewing UI.** Stage 2 renders *Postings from Findings*, which is
  adjacent to but not the same as `OVERVIEW.md`'s "Dashboard views a brief" —
  the brief markdown stays reachable only from S3, because the dashboard
  deliberately gains no `:briefs` grant.

## The riskiest assumption

**That a letter written from a two-or-three-sentence Posting summary plus the
candidate's CV is worth the surface built around it.**

The candidate half is solid — it is the user's own text. The Posting half is the
weak one: the agent never sees the advertisement's actual requirements, so every
letter's "why I fit" paragraph reasons from `summary` and `matchReason`, two
sentences the Scout wrote from a search snippet. If those letters read as
generic, the fix is Stage 4.2 (a posting reader), and Stages 2–3 will have built
storage, IAM, a new object kind and a dashboard section for a feature not yet
worth having.

This is why Stage 1 is scoped the way it is: it is zero-infra, zero-storage,
zero-migration, and it produces a real letter from real data. If the output at
the end of Stage 1 is not convincing, the correct move is to reorder — Stage 4.2
before Stage 2 — rather than to proceed.
