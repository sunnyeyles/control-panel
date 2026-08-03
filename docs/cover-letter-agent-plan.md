# Cover Letter Agent — staged plan

> **Revised against `main` at `b511e6c`.** The plan was written before three
> merges landed — #73 (Server Action scaffolding deduped), #74 (the scout
> searches SEEK instead of the web) and #76 (`@workspace/db` ported to Prisma,
> `OVERVIEW.md` and `CONTEXT.md` deleted). The design survived all three; the
> citations did not. Decision 1 and §The riskiest assumption are rewritten
> because #74 changed what the scout can honestly report, and the database API
> names throughout are the Prisma ones. See §What changed under this plan.

## Context

**Cover letters do not exist.** `packages/agents/src/` holds `assistant`,
`brief-writer`, `findings` and `job-scout`, and nothing else. Today the pipeline
is `config → scout ⇢ Findings → Brief Writer → markdown → S3 → artifacts row`:
two agents joined by plain TypeScript, with `parseFindings()` validating the
hand-off. The output is a Briefing the user cannot yet read anywhere.

This used to cite `OVERVIEW.md` §Not built yet, which was the register of
intended-but-unbuilt parts. That file and `CONTEXT.md` were **deleted in
`7752b71` ("Finish migration")** — a Prisma commit — while `CLAUDE.md:224` and
`README.md:14-19` still describe both as current reading. That looks like
collateral rather than a retirement, and **restoring them is a prerequisite this
plan assumes**: several arguments below rest on vocabulary and precedent those
two files were the authority for. Where a citation is now dangling, the
reasoning is restated from the code instead, and the dead reference is kept in
parentheses so a restore can re-point it.

The feature to add is **one cover letter per Posting** — a first-person draft
for a specific open advertisement, written in the candidate's voice. That last
clause is what makes this different from every agent already here. The Brief
Writer summarises what a search found; a cover letter _asserts things about a
person_ to a stranger. An invented "I led the migration of…" is not a thin
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
2. **The per-kind IAM policy grants read _and_ write _and_ delete together** —
   `modules/user-storage/main.tf`'s `kind_access`. There is no read-only
   variant, so "let the dashboard see the Findings" is currently spelled "let
   the dashboard overwrite the Findings".
3. **`startAdHocRun(prisma, jobId)` exists**, so an ad-hoc `runs` row _is_
   reachable — the on-demand path is not blocked on the schema. It is rejected
   below for semantic reasons, not because it is impossible.

A fourth, added on revision and the one that moved a decision:

4. **The scout searches SEEK's live inventory, not the web** (#74).
   `packages/agent-tools/src/seek-search.ts` returns, per posting, `teaser`,
   `bulletPoints[]`, `workType`, `workArrangement`, `salaryLabel` and
   `publishDateISO`, all rendered into the stanza the model reads. The scout
   therefore _does_ see something like requirements. Decision 1 was written on
   the opposite premise and is rewritten below.

Doc drift, no longer fixable in passing: the note that used to live here
corrected `OVERVIEW.md:24`'s "Search and fetch tools" label. That file is
deleted, so the correction is moot — but the underlying fact changed too, and
matters: `packages/agent-tools/src/` is now `seek-search.ts`, `web-search.ts`
and `time.ts`. There is still no fetch tool, and this plan still does not add
one.

---

## The six decisions

### 1. Where the substance comes from

> **Rewritten.** The original decision refused to extend `PostingSchema` on the
> grounds that the scout saw only search snippets, so asking it for requirements
> would be asking it to invent them. #74 made that false. The refusal was right
> about _composed_ text and is kept for it; it was wrong about text the tool
> actually returns, and is reversed for that.

**Decision:** the candidate's side comes from **a document the user has already
uploaded**, read verbatim through `ResumeStore`, restricted in v1 to `.md` and
`.txt`. The Posting's side comes from **the `Posting` record and nothing else** —
but that record gains **one optional field, `highlights: string[]`, copied
verbatim from the SEEK stanza's bullet points**. No page is fetched.

`highlights` is safe to add for exactly the reason the original refusal was
right: it is _copied, never composed_. It carries the same discipline `url`
already does — the schema's stated purpose is that "a URL the scout assembled
rather than received is a fabrication, and the schema rejects it", and the
`.describe()` on `highlights` says the same about bullet points, that they are
reproduced from the listing or the field is omitted. Optional, so every existing
brief and every stored Findings artifact stays valid, and a scout pass that
found nothing to copy simply leaves it out.

What this does not license: a `requirements` field the model _summarises_ into,
or any field describing the role that the tool did not hand it. Those remain the
fabrication surface the original decision refused, and refusing them is why this
one field is enough.

Why not the alternatives:

- **A fetch tool is still the right eventual answer and the wrong first one.**
  It is a real security surface (SSRF, redirect chains, response size, and
  prompt injection from a page the model then acts on), and it must not live on
  the agent that holds the candidate's CV — see decision 2. Staged to §Stage 4,
  and #74 lowered its priority: the cheap 80% is `highlights`, and after that
  the next increment is Apify's own `fetchDetails` flag — deliberately off in
  `seek-search.ts` because detail pages triple the scrape time — not a fetcher
  this repo has to write and defend.
- **A user-typed profile field** would need a config-update function, which does
  not exist — `@workspace/db` exports `createJob`, `dueJobs`, `claimJob`,
  `updateJobSchedule`, `pauseJob` and `resumeJob`, and `jobs.config` is written
  only by `createJob()`. It would also need a form and a third copy of a schema
  `search-criteria.ts` already apologises for duplicating (its header still names
  the fix — "lift that module into a shared package"). More new surface than
  reading a file the user already uploaded, for weaker substance.
- **Reading the uploaded document is nearly free where the letter is drafted.**
  The dashboard already holds `prod:resumes`, already has an upload UI, and
  `lib/documents/list-documents.ts` already `head()`s every object and returns
  `documentType` — so "the newest document the user labelled `resume`" is one
  existing function call away.

**What the letters will read like, honestly.** The candidate half will be
genuinely specific: it is the user's own CV text, quoted and reorganised. The
Posting half is **no longer thin, but it is still second-hand**: a title, a
company, a location, `summary` and `matchReason` written by a different model,
plus `highlights` copied off the listing. That last field is what lets a "why I
fit" paragraph name something the advertisement actually asked for instead of
paraphrasing a summary. It is not the full advertisement — SEEK's bullet points
are the teaser, not the requirements section — so the letters should read as
specific but not exhaustive about the role.

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
  Posting is attacker-influenced text, and an agent that can both read a CV and
  issue a request can be induced to put one inside the other. Tool-lessness is
  not a quality preference here, it is the containment.

  **#74 sharpened this rather than softening it.** The text now originates in a
  SEEK advertisement, which anyone who can pay to post one controls, and
  `highlights` (decision 1) carries it into the prompt _verbatim_ rather than
  laundered through the scout's paraphrase. Copying is what makes the field
  honest and is also what preserves any instruction hidden in it. The letter
  writer having no tools is precisely what makes that acceptable: injected text
  can shape the prose of a draft the user then reads and edits, and can reach
  nothing else.

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
  `latestArtifactForJob()` still has no caller — nobody has read a single brief
  through the UI yet. Generating 8 letters per day for an unread digest is the
  clearest waste available.
- `runTick` is sequential in one Lambda invocation. Eight extra sequential model
  calls per due job push a tick toward its timeout for no user-visible gain.
- It multiplies the failure surface of the product by the failure surface of an
  accessory: eight more chances to break a Run that would otherwise succeed.

The honest cost of choosing on-demand: **there is no UI showing a Run's output
at all**, so this feature has to build one. That is Stage 2 and it is real work,
not a footnote. It was also work the product already wanted done — "Dashboard
views a brief" was an `OVERVIEW.md` §Not built yet entry before that file was
deleted.

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
  vocabulary: a **Document** is something the user uploaded themselves (the
  definition `CONTEXT.md` carried, and which `kinds.ts` still encodes — `resumes`
  is commented "documents the user uploaded themselves", and is the only kind
  stored `Content-Disposition: attachment` because those bytes came from
  outside). A `documentType: "cover-letter"` label would stop distinguishing a
  letter the user wrote from one the machine wrote, and would file
  machine-generated text under a posture chosen for untrusted uploads. In this
  repo that last one is a real reason, not a stylistic one.

What a new kind obliges, in full — omitting either half is the failure
`kinds.ts` warns about in its header comment (no retention, and writes 403 for
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
URL is the one field the schema guarantees was _copied and not composed_, which
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
against one `run_id` does hold**, and survived the Prisma port unchanged.
`@@index([runId], map: "artifacts_run_id_idx")` is non-unique, only `objectKey`
is `@unique`, and `artifactsForRun()` returns an array. So the in-run variant was
available; it is rejected on the grounds in decision 3, not by the schema.

**Decision: a cover letter is recorded in S3 and nowhere else.**

- `Artifact.runId` is non-null (`runId String`, with a required relation). An
  on-demand letter has no Run — a **Run** is one execution of a job (the
  definition `CONTEXT.md` carried; `schema.prisma` still encodes it, since every
  `runs` row hangs off a `jobId`), and drafting a letter is not an execution of
  a briefing job. Minting an ad-hoc `runs` row per click (which `startAdHocRun`
  would happily do — `scheduledFor` is nullable precisely so ad-hoc runs stay
  unlimited) pollutes the job's run history with rows that are not briefings.
- The key is fully derivable from `(userId, postingId)`, so a row buys no
  addressability that `CoverLetterStore.list(userId)` does not already give.
- **The precedent is already in the repo.** Uploaded documents have no Postgres
  row for exactly this reason: S3 is the only record of an upload, because
  `artifacts` has no row shape for one — its `runId` is required and an upload
  has no Run. (`OVERVIEW.md` used to state this outright; the code still does.)
  The same reasoning applies verbatim to an on-demand letter.

**What the dashboard queries.** For letters: nothing in Postgres —
`CoverLetterStore.list(userId)`, plus a `head()` per item for display metadata.
That is the same deliberate N+1 `list-documents.ts` already documents and
accepts (it `head()`s every object because `originalFilename` and `documentType`
live in S3 user metadata, which a listing does not return). For Postings: the
job's most recent `succeeded` run → `artifactsForRun(prisma, run.id)` → pick by
`parseObjectKey(key).kind === "findings"`.

⚠️ **`latestArtifactForJob()` becomes ambiguous and must not be used.** It
returns a single row ordered by the run's start and the artifact's creation;
once a Run writes two artifacts it returns whichever was recorded last. It still
has no caller, which is why this is a trap rather than a bug. The path above is
kind-explicit and needs **no change to `@workspace/db` at all** — `artifactsForRun`
is already exported.

### 6. Failure semantics

The precedent is _"a run with no successful search fails"_, and its reasoning is
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
   _after_ the brief, inside a `try/catch`; a failure adds a warning to the
   `SuccessReport` and `runTick` passes it to
   `finishRun(prisma, slot.runId, warnings)` — whose third parameter already
   exists and is already typed for this. `packages/db/src/types.ts` still states
   the rule: _"Succeeded with warnings is `succeeded` with a non-empty
   `failure`."_ A Run that produced a Briefing succeeded, whatever happened to
   the accessory.

   Note the shape: that parameter is `RunFailure`, i.e.
   `Record<string, unknown>`, not `string[]`. So the warning the worker carries
   should be an object (`{ findings: "…" }`), and `SuccessReport` should gain
   `warnings?: RunFailure` rather than the `string[]` an earlier draft of this
   plan assumed.

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
question before anything is built around it: _are the letters any good with only
a Posting record and a CV?_

**Added**

| File                                         | Role                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agents/src/cover-letter.ts`        | The contract, beside `findings.ts` and for the same reason — it belongs to neither side. `CandidateProfileSchema` (`name?`, `background`), `CoverLetterRequestSchema` (`posting: PostingSchema`, `profile`), `assertDraftable()`, `toCoverLetterPrompt()` (pure), `MIN_/MAX_BACKGROUND_CHARS`.         |
| `packages/agents/src/cover-letter-writer.ts` | `COVER_LETTER_WRITER_SYSTEM_PROMPT`, `CreateCoverLetterWriterOptions = Omit<CreateAgentOptions, "tools">`, `createCoverLetterWriter()` → `createAgent({ ...rest, systemPrompt, tools: [] })`. One agent per module, a `createX()` factory, never an instance.                                          |
| `apps/briefing-worker/src/dev/letter.ts`     | A `tsx` CLI: `--findings <file.json> --profile <file.(md\|txt)> --posting <n>` → letter on disk. Lives here because this is where the harness machinery already is and nothing under `dev/` reaches `dist/` (the esbuild entry is `src/index.ts` alone). `@workspace/agents` has no runner of its own. |

**Changed**

- `packages/agents/src/findings.ts` — add `postingId(posting: Posting): string`.
  Uses `node:crypto`; the package already carries `@types/node`.
- `packages/agents/src/findings.ts` — add the optional `highlights: string[]` to
  `PostingSchema` (decision 1), with a `.describe()` that says _copied from the
  listing, omitted if there is nothing to copy_. `jobScoutSchemaDescription` is
  derived from the schema, so the scout's prompt updates itself; no edit to
  `job-scout.ts` is needed for the field to be asked for.
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

- `toCoverLetterPrompt()` carries the Posting URL, the background and any
  `highlights` verbatim.
- `assertDraftable()` rejects absent, short and oversized backgrounds.
- `PostingSchema` still parses a Posting with no `highlights` — the field is
  optional, and every Findings artifact written before this change lacks it.
- `postingId()` is stable, and matches `SEGMENT_PATTERN` from
  `@workspace/user-storage/keys`.
- **The tool set is asserted structurally**: drive `createCoverLetterWriter({ model })`
  with a fake `ChatModelLike` whose `bindTools(tools)` records its argument, and
  assert it received `[]`. `ChatModelLike` is structural precisely so this works
  with no key.

### Stage 2 — Findings become durable and visible

Nothing about letters. This is the surface the on-demand choice obliges, and it
is also "Dashboard views a brief" — an `OVERVIEW.md` §Not built yet entry, before
that file was deleted — one step short.

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
  assertion compares the two _write_ attachments and stays literally true,
  gaining the sharper meaning "no write grant is shared".
- `tests/user_storage.tftest.hcl` — assert `cover-letters` has no `expiration`
  block at all (the `resumes` assertion's shape), and that `prod:findings` exists
  as a key.
- `tests/vercel_dashboard.tftest.hcl` — the `== ["prod:resumes"]` assertion
  becomes `== ["prod:cover-letters", "prod:resumes"]` with a restated reason, and
  a new assertion pins the read attachment to exactly `["prod:findings"]`.

**Worker**

- `run-briefing.ts` — after the brief's `upload` and `record` steps, a
  `findings` step: serialise the validated `Findings`, `findings.put(...)`, then
  record it. Note the seam #76 left behind: `runBriefing` no longer takes an
  artifact store, it takes a `recordArtifact: (runId, objectKey) => …` callback
  that `run-tick.ts` closes over `prisma` to supply. The findings step uses that
  same callback, so nothing new is injected. Wrapped so a failure adds
  `warnings?: RunFailure` to `SuccessReport` rather than throwing, and `runTick`
  passes it to `finishRun(prisma, slot.runId, warnings)` — today that call site
  passes two arguments and gains a third.
- `index.ts` — construct `createFindingsStore(createS3UserObjectStore())`
  alongside the brief store; `runTick`/`runBriefing` take it as a parameter
  beside `briefs: BriefStore`, so nothing AWS-shaped leaves `index.ts`.
- `dev/stores.ts` — nothing to change; `createDirectoryObjectStore` is at the
  `UserObjectStore` layer, so the real `createFindingsStore` composes on top and
  the harness writes the JSON beside the markdown for free.

**Dashboard**

- `app/(app)/briefings/page.tsx` (+ `lib/nav.ts` entry) — **Briefings**, the
  vocabulary-correct name. `force-dynamic`, `maxDuration = 30`, and its own
  **`requirePageUser()`** call — #73 extracted the three redirect lines every
  page had copied into `lib/auth/require-page-user.ts`, so this page calls that
  rather than hand-rolling `getCurrentUser()` and the redirects. Still per page,
  not inherited: the layout's call is for the sidebar, not the gate. Latest
  `succeeded` Run per job → `artifactsForRun(prisma, run.id)` → the `findings`
  key by `parseObjectKey` → `FindingsSchema.parse` → a list of Postings.
- `lib/briefings/latest-findings.ts` — that resolution as a pure-ish function
  over an injected `PrismaClient` and `FindingsStore`, so it is testable.

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

**#73 changed what this stage writes from scratch.** The per-feature
`action-state.ts` files this plan proposed mirroring are gone, merged into
`lib/actions/action-state.ts` (`ActionState`, `IDLE`, `carryResetKey`) and
`lib/actions/require-user.ts` (`requireUser(getUser, domain)` → `Caller`,
plus the single `NOT_AUTHORIZED` constant). So the letter actions **reuse those
rather than defining their own**: `requireUser(deps.getUser, "briefings")` is
the authorization line, and its refusal is a message to be stamped with
`carryResetKey`, not a bare state. The `createXActions(deps)` factory shape the
plan copies is unchanged — `createDocumentActions` is still the model.

| File                                        | Role                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/cover-letters/cover-letter-actions.ts` | `createCoverLetterActions(deps)`. **Imports nothing from Next.** Deps: `getUser`, `getResumes`, `getCoverLetters`, `getFindings`, `getDb`, `createWriter?`.                                                                                                                                                                                                           |
| `lib/cover-letters/profile.ts`              | `readProfile(userId, resumes)` — `listDocuments()` → newest `documentType === "resume"` with `.md`/`.txt` → `resumes.get()` → decode → `assertDraftable`. Returns a discriminated result, never throws for the expected "no readable CV" case.                                                                                                                        |
| `lib/cover-letters/agent.ts`                | `CoverLetterAgentLike { invoke(input): Promise<{ messages: BaseMessage[] }> }` — the narrow structural seam, mirroring `AgentLike` in the worker. With zero tools the graph is one model call, so `invoke` suffices and `run-agent.ts` is not needed (apps do not depend on apps; the small duplication is noted in the file, as `search-criteria.ts` notes its own). |
| `app/(app)/briefings/actions.ts`            | `"use server"`, thin wrapper, `refresh()` on success.                                                                                                                                                                                                                                                                                                                 |
| `components/briefings/*`                    | A per-Posting draft button and a letters list.                                                                                                                                                                                                                                                                                                                        |

**The action's two non-obvious rules**, both worth stating in the file:

- **The form carries `runId` and `postingId` only — never the Posting itself.**
  The Posting is re-read server-side from the Findings artifact and matched by
  `postingId`. Taking it from the form would let a caller put arbitrary text into
  a stored document and would destroy the "URLs are copied, never composed"
  guarantee at the last step of the chain that maintains it.
- **`runId` arrives from a form, so ownership is checked explicitly**: load the
  run, load its job, and require `job.userId === caller.userId`. Under Prisma
  that is one query with a relation include, not two round trips. The S3 key is
  then built from the _session's_ `userId`, never from anything in the form —
  the same posture as `document-actions.ts`, which is why `assertSegment()` is a
  second line of defence rather than the only one.

Order of operations mirrors the worker: write the object, then (here) nothing —
there is no row, per decision 5.

**Testing** — `@workspace/dashboard` already has vitest, and nothing under
`lib/cover-letters/` imports Next, which is what makes it reachable. Fake
stores, a fake Prisma client, and a fake agent returning an `AIMessage`. Cases: not
signed in; signed in but the Run belongs to another user's job; no readable CV;
`postingId` not present in the Findings; success writes
`.../cover-letters/{postingId}.md`; a redraft writes the same key; a
form-supplied posting body is ignored.

### Stage 4 — better substance (not scheduled)

Three independent widenings, in this order. **#74 reordered them**: what used to
be 4.2 is now split, and its cheap half comes first.

1. **Wider profile formats** — PDF/DOCX text extraction, a parser dependency in
   the dashboard. Removes the `.md`/`.txt` restriction, changes no interface.
2. **`fetchDetails` on the SEEK actor** — `seek-search.ts` deliberately leaves it
   off, commented "the teaser and bullet points carry enough for a two-sentence
   summary, and detail pages triple the scrape time". If the letters want the
   real requirements section, this is a one-flag change against a source that is
   already trusted, already rate-limited and already inside the tool's own
   schema. It costs scrape time, not a new security surface. **Try this before
   writing a fetcher.**
3. **A posting-reader agent** — only if 2 is insufficient. A new
   `packages/agent-tools/src/fetch-page.ts` (scheme allowlist, redirect and size
   limits, no private address ranges) and a
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
   `artifactsForRun(prisma, runId)` returns two rows for the Run, and
   `/briefings` renders the Postings.
4. **Stage 3** — draft a letter from `/briefings`; confirm the object key,
   confirm a second draft of the same Posting overwrites rather than adds
   (S3 shows two versions, one current), and confirm the action refuses when no
   `.md`/`.txt` document is labelled `resume`.

---

## Open questions

1. Is "upload your CV as `.md` or `.txt`" acceptable for v1, or must PDF work on
   day one (moving Stage 4.1 ahead of Stage 3)?
2. Findings in S3 as a new kind (chosen — infra + two test edits) or
   `runs.findings Json?` (one Prisma migration, zero infra)? I chose S3 on the
   platform's organising rule that Neon stores object keys and not payloads —
   still visible in `schema.prisma`, where `Artifact` is an `objectKey` and
   nothing else — but the Postgres route is roughly half the work, and #76 made
   it cheaper: a migration is now `prisma migrate dev` against the schema rather
   than hand-written SQL. **Worth reopening on that basis.**
3. Read-only per-kind IAM policy for the dashboard's Findings grant (chosen), or
   is the existing read/write policy acceptable and the disjointness assertion
   simply relaxed?
4. Cover-letter retention: never expire, like `resumes` (chosen), or 365 days,
   like `briefs`?
5. Is `/briefings` the right route and nav entry, or should Postings appear
   under an existing section?
6. Re-drafting the same Posting overwrites the previous letter. Correct, or
   should each draft be kept as a separate object?
7. **New, from #74.** `highlights` on `PostingSchema` (decision 1) widens a
   contract shared by the scout, the brief writer and every stored Findings
   artifact, for the benefit of a feature that does not exist yet. Optional and
   copy-only, so nothing breaks — but if the preference is to keep that contract
   frozen until Stage 1 proves the letters are worth it, the field can move to
   Stage 2 and Stage 1 can read `bulletPoints` straight from a fixture. Ordering
   preference, not a design fork.

## Deliberately not building

- **A page-fetch tool.** Still the eventual answer to thin Posting substance, and
  still not safe or cheap to add in the same change as an agent holding the
  candidate's CV. (`PostingSchema` _is_ now changed, by one optional copy-only
  field — see decision 1. What stays unbuilt is any field the model composes
  rather than copies.)
- **Profile extraction.** `jobs.config` stays hand-written; this feature reads a
  document directly and writes nothing back to the search criteria.
- **In-run letter generation.** Costed in decision 3.
- **An `artifacts` row per letter, and any ad-hoc `runs` row.** Decision 5.
- **PDF/DOCX text extraction.** Stage 4.
- **Editing, regenerating with instructions, tone selection, or sending.** A
  letter is drafted, stored, downloaded. Nothing more.
- **A `jobs.config` update function** and a search-criteria edit form — adjacent
  missing features this change does not need.
- **A brief-viewing UI.** Stage 2 renders _Postings from Findings_, which is
  adjacent to but not the same as "Dashboard views a brief" — the brief markdown
  stays reachable only from S3, because the dashboard deliberately gains no
  `:briefs` grant.

## The riskiest assumption

> **Rewritten.** #74 did not remove this risk, but it materially reduced it and
> changed what the fallback costs.

**That a letter written from a SEEK teaser plus the candidate's CV is worth the
surface built around it.**

The candidate half is solid — it is the user's own text. The Posting half is
still the weak one, but it is weak differently than when this plan was written.
The agent no longer reasons only from two sentences another model wrote: with
`highlights` it sees the advertisement's own bullet points, verbatim. What it
still does not see is the full requirements section, because SEEK's search
results carry the teaser and `seek-search.ts` leaves `fetchDetails` off. So the
open question is no longer "can it say anything specific about the role" — it
can — but "is teaser-level specificity enough to beat a generic letter".

The fallback got cheaper too. If the letters read thin, the next move is
Stage 4.2 — one flag on an actor already in the codebase — and only after that a
posting reader. The downside scenario that used to justify reordering the whole
plan now costs a scrape-time increase.

Stage 1 is still scoped to answer this before anything is built around it: it is
zero-infra, zero-storage, zero-migration, and it produces a real letter from real
data. If the output at the end of Stage 1 is not convincing, try `fetchDetails`
and re-run Stage 1 before building Stage 2.

---

## What changed under this plan

Merged after this plan was written, in the order they landed. Each entry is what
the plan had to change, not a summary of the PR.

| PR                                          | Effect on this plan                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#73** Server Action scaffolding deduped   | Stage 3 reuses `lib/actions/action-state.ts` and `lib/actions/require-user.ts` instead of mirroring the per-feature files it was written against; Stage 2's page calls `requirePageUser()`. The `createXActions(deps)` shape is unchanged.                                            |
| **#74** Scout searches SEEK, not the web    | **Decision 1 reversed in part** — `PostingSchema` gains an optional copy-only `highlights`. Decision 2 sharpened rather than weakened. §Riskiest assumption rewritten. Stage 4 reordered around `fetchDetails`.                                                                       |
| **#76** `@workspace/db` ported to Prisma    | Every database name restated: `startAdHocRun`, `finishRun(prisma, runId, warnings)` (a `RunFailure`, not `string[]`), `artifactsForRun`, `latestArtifactForJob`. `runBriefing` takes a `recordArtifact` callback, not a store. Open question 2 reopened — a migration is cheaper now. |
| **#76** `OVERVIEW.md`, `CONTEXT.md` deleted | ~15 citations restated from the code. See §Context: the deletion landed inside a Prisma commit while `CLAUDE.md` and `README.md` still reference both files, and restoring them is assumed.                                                                                           |

Verified unchanged, because the plan's costliest arguments rest on them:
`tests/vercel_dashboard.tftest.hcl:80` still asserts
`keys(...) == ["prod:resumes"]`; `modules/user-storage/main.tf` still publishes
only the read/write/delete `kind_access` policy and no read-only variant;
`kinds.ts` still holds `briefs` and `resumes` alone; `Artifact.runId` is still
required and `artifacts_run_id_idx` still non-unique.
