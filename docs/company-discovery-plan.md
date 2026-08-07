# Company discovery — finding startups worth working for

> ## Not built. This is a plan, not a description of the code.
>
> Nothing in the tree discovers a company today. There is no `companies` table,
> no prospector agent, no page-reading tool, and no `/companies` page. The
> present tense below is the present tense of a design.
>
> Delete this file when the work ships — `CLAUDE.md` §Repo context is where that
> convention lives, and git history is where a shipped plan belongs. It is
> `docs/company-discovery-plan.md` rather than a bare `plan.md` because that is
> where `docs/job-kind-registry-plan.md` already lives, and a second file called
> `plan.md` would not say which plan it was.

## What is being asked for

Find AI and software startups the user could work for — Australian, or hiring
remotely — and build a list clean enough to enrich with contact details, rank by
fit, and use for outreach. Per company: name, website, what they do, location,
whether AI/software is core to the product, whether they appear to be hiring, the
careers page, and publicly listed technical leadership.

**That is the inverse of the pipeline this repo already runs.** The briefing
pipeline starts from a **Posting** and treats the company as a string transcribed
off the advertisement (`packages/agents/src/findings.ts:37-46` — `company` is
free text, and `"Unknown"` is a legal value). Discovery starts from the
_organisation_ and treats postings as one of several signals about it. The two
meet at exactly one place, and it is worth naming early: a company with an open
advertisement on SEEK is _demonstrably_ hiring, and this repo already holds a
live SEEK tool.

---

## Vocabulary, before anything else

`CONTEXT.md` binds prose in this repo, and discovery adds nouns that collide with
words already spoken for. Settle them here; fold them into `CONTEXT.md` when
Stage 1 ships.

**Company** — an organisation that might employ the user. A row in `companies`,
one per (**User**, Company). **Not** `postings.company`, which is a free-text
column a model transcribed off one advertisement and which this table does not
read. _Avoid_: employer, org, startup (in schema and code — fine in prose about
what the user is looking for), lead, account.

**Prospector** — the agent that finds Companies. Deliberately not "Scout": the
**Scout** is the existing job-scout, `CONTEXT.md` already defines it, and one
word meaning two agents is how a prompt ends up in the wrong package. _Avoid_:
scraper, crawler, company scout, researcher.

**Company Findings** — what one Prospector run reports, validated by
`CompanyFindingsSchema`. Parallel to **Findings**, and never called that
unqualified: **Findings** means the Scout's, and `runs.findings` already holds
one shape.

**Company Status** — where the user has got to with one Company: `new`,
`shortlisted`, `contacted`, `rejected`. The one column in the new table a
_person_ writes, exactly as **Posting Status** is in `postings`.

**Discovery** — the briefing kind. A **Job** whose `config.kind` is
`company-discovery`. To a user it is still a **Briefing**, because that is the
only word the interface uses.

---

## Where the code contradicts the brief

Four facts, each checked against the code rather than the docs. Every one of them
constrains the design.

**1. There is no way to read a web page, and that is deliberate.**
`OVERVIEW.md:37-48` states it outright: five tools, no fetch tool, "nothing
retrieves an arbitrary URL, and nothing should acquire that ability casually — a
fetcher is a security surface (SSRF, redirect chains, response size, prompt
injection from a page the model then acts on)."

Discovery needs page content. A VC portfolio page, an accelerator's cohort list
and a company's own site are the sources, and `web-search.ts` returns a title, a
URL and a snippet — enough to know a page exists, never enough to say what a
company does or who its CTO is. **This is the central tension in the whole
feature**, and §Decision 2 is the answer.

**2. Nothing dispatches on a job kind.** `apps/briefing-worker/src/run-tick.ts`
calls `runBriefing(...)` unconditionally for every due row, and `runBriefing`
calls `parseJobSearchConfig` first, which throws on anything not job-search
shaped (`job-search-config.ts:116-129`). So a discovery job written into `jobs`
today would claim a slot, fail at config parse, be marked `failed`, and make the
whole tick rethrow into a latched daily alarm.

`docs/job-kind-registry-plan.md` designs the fix and nothing implements it.
**That plan is a hard dependency of Stage 5 here and of nothing earlier.**

**3. The dashboard cannot read a brief, and never needed to for this.** The app's
IAM grants are `prod:resumes`, `prod:cover-letters` and `prod:tailored-resumes`;
briefs live under `prod:briefs` (`OVERVIEW.md:216-224`). What `/briefings` shows
is the `postings` _table_. Discovery should copy that and not the brief —
§Decision 5.

**4. Identity is derived, never assigned, and there is exactly one
implementation.** `postingId()` (`packages/agents/src/posting-id.ts:129`) hashes
a normalised URL to sixteen hex characters, and the `postings` table CHECKs that
shape because the value is also an S3 key segment
(`0005_postings/migration.sql:65-66`). A company needs the same treatment and a
different rule — §Decision 3, which is where the `.com.au` problem lives.

---

## The six decisions

### 1. Discovery is a job kind, not a new service

A Discovery run is: read the config → search → judge → record Companies. That is
the same shape as a briefing run with a different middle, and it wants the same
scheduler, the same at-most-once claim, the same `runs` row, the same tick, the
same alarm. Building a second worker would duplicate all of it.

So it is a **Job** whose `config.kind` is `company-discovery`, its config schema
lives beside `job-search-config.ts` in the worker, and `@workspace/db` never
reads inside it — the platform's organising rule
(`0001_init/migration.sql:3-4`).

**What this costs is stated plainly: Stage 5 cannot ship without the registry.**
Stages 1–4 are drivable from a script and an ad-hoc run, so the dependency is
real but late.

### 2. Page reading goes through Tavily's extract endpoint, on an agent that has never seen the CV

Three options, and the cheap one does not work.

- **(a) Search snippets only.** No new capability, no new credential. Yields a
  name, a URL and one sentence. Cannot answer "is AI core to the product",
  "who is the CTO", or "are they hiring" — every one of those is a claim about
  page content. A run built on (a) produces a list where the interesting columns
  are guesses, which is worse than a shorter honest list.
- **(b) Tavily's extract endpoint.** A second REST call against a credential
  the repo already holds (`TAVILY_API_KEY`), hand-rolled over `fetch` exactly as
  `web-search.ts:111-168` is. **The request leaves our infrastructure as a URL
  handed to a third party**, so there is no socket opened from the Lambda to an
  attacker-chosen host: SSRF, redirect chains and response-size limits become
  Tavily's problem rather than ours. Prompt injection does not — see below.
- **(c) A real HTTP fetcher with an allowlist and SSRF guards.** Strictly more
  capability, strictly more surface, and every guard is ours to get right.

**Take (b).** It buys the content the feature is about while leaving the
objection in `OVERVIEW.md:37-48` mostly intact — three of its four named hazards
are structurally out of reach.

The fourth is not, and it is the reason for the second half of this decision.
Extracted page text is attacker-controlled: a startup's careers page can say
anything, including instructions. `CONTEXT.md` already wrote the rule this must
follow, under **Letter Writer**: _"When a page fetcher is eventually added it
goes on a different agent that never sees the profile."_ The Prospector is that
agent. It holds search criteria and page text and **never** loads the candidate's
background — no `loadCandidateBackground`, no resume text, no
`profile-extractor` reuse. Injected text can shape a JSON object a person then
reviews, and can reach nothing else.

Three containment rules follow, and they belong in the tool rather than in a
prompt:

- **The extracted text is truncated** to a stated byte budget, and the truncation
  is visible in the rendering, as `get_posting_details` already fences and
  truncates a description.
- **The tool takes ids, not URLs** — §Decision 4.
- **Extract failure is a string, not a throw.** `web-search.ts:141-167` sets the
  posture: a missing or rejected key throws because no rephrasing fixes it;
  everything else comes back as helpful text so one bad page does not sink a run.

**Verify before building:** confirm the extract endpoint's current path, request
shape, per-call quota and pricing against Tavily's live API docs. This plan
assumes it exists in roughly the shape `web-search.ts` already talks to, and a
plan is not a source for an API contract.

### 3. A Company's identity is its normalised host, and the `.com.au` problem is why the rule is conservative

`postingId()` hashes a whole normalised URL because two links to one
advertisement differ only in tracking stamps. That rule is wrong here: a company
arrives as `blackbird.vc/portfolio/foo`, `foo.com.au/`, `www.foo.com.au/careers`
and `foo.com.au/about`, and all four are one company.

So `companyId()` hashes the **normalised host**:

1. Lowercase the host; drop a leading `www.`.
2. Drop the scheme, path, query and fragment entirely.
3. SHA-256, sliced to sixteen hex characters — the same shape and the same
   S3-key-segment property `posting-id.test.ts` already asserts against
   `@workspace/user-storage`'s own predicate.

**It does not attempt to extract a registrable domain, and the Australian focus
is exactly why.** A naive "keep the last two labels" rule turns every
`foo.com.au` into `com.au` and merges the entire Australian market into one row.
Doing it correctly needs a public-suffix list, which is a dependency, a data file
that goes stale, and a second identity rule to keep in step with the first. The
conservatism `posting-id.ts:23-38` already argues for applies with more force
here: **failing to merge two hosts costs a duplicate row a person can see and
delete; merging two companies destroys one of them silently.**

**What this costs, stated plainly:** `foo.com.au` and `foo.io` are two rows, and
so are `foo.com` and `careers.foo.com`. Both are visible duplicates in a list the
user reads, which makes them self-correcting. A merge tool is a later slice, and
the row's `payload` keeps every URL a run saw so a merge would have something to
work from.

### 4. The Prospector names companies by id, never by URL

The Scout never handles a URL, and `resolve-postings.ts` records the seven
production runs lost to a model retyping a LinkedIn link. The same discipline
transfers unchanged: searches record into a **company catalog** keyed by
`companyId()`, the Prospector reports ids, and the worker resolves each id back
to the URL the search returned. An id no search returned names nothing, so a
fabricated company cannot pass — which is the property that matters most in a
feature whose entire output is a list of names a model produced.

`createPostingCatalog` (`packages/agent-tools/src/posting-catalog.ts:99`) is
already three-quarters of this: it takes `idFor` as an injected function
precisely so the tools package need not depend on `@workspace/agents`. Generalise
it or copy it — Stage 2 decides, and the decision is small either way.

**One consequence is genuinely awkward and must not be papered over.** The
careers page is a _second_ URL, and under this rule the Prospector cannot report
one it has not been handed. Three sub-cases:

- The careers page was itself a search result → it is in the catalog and has an
  id. Report the id.
- The careers page was a link on an extracted page → the extract tool records
  discovered links into the catalog too, so it also has an id.
- Neither → **`careersUrl` is absent.** Not guessed, not `/careers` appended.
  Resolving conventional careers paths is a later enrichment step with a live
  check behind it, and a 404 stored as a careers page is worse than a blank.

### 5. A Discovery run writes a table, not a brief

`runBriefing` treats landing in S3 as the success signal. A Discovery run's
success signal is the `companies` upsert, and it writes **no S3 object and no
`artifacts` row at all**.

Three reasons, in ascending order of force. A markdown digest of companies is not
what the user asked for — the ask is a list to enrich and rank, which is a table.
A new object kind costs a `kinds.ts` entry _and_ a matching `object_kinds` entry
in Terraform or writes 403 for want of the per-kind grant
(`OVERVIEW.md:91-92`) — a manual apply outside Turborepo. And the dashboard could
not read it anyway without widening an IAM grant that
`tests/vercel_dashboard.tftest.hcl` asserts the exact key set of.

`artifacts.run_id` is `NOT NULL`, so "no object" simply means no row — the same
shape a **Document** and a **Cover Letter** already have.

### 6. Every judgement is stored with its evidence, and "unknown" is a value

"Is AI core to the product" and "do they appear to be hiring" are model
judgements about pages, not facts. Stored as bare booleans they are
indistinguishable from "nobody checked", and a `false` that means "the page did
not load" is the kind of quiet wrong answer this repo's `postings` rules exist to
prevent.

So both are three-valued and both carry their evidence:

- `ai_core`: `core` | `applied` | `none` | `unknown`, plus `ai_evidence` — a
  sentence quoted from what was read, not composed. The middle value earns its
  place: a logistics company with an ML pricing model is a real and different
  answer from an AI-first product company, and collapsing them loses the
  distinction the user is actually filtering on.
- `hiring`: `open-roles` | `careers-page-only` | `none` | `unknown`, plus
  `hiring_evidence` and `hiring_checked_at`. `open-roles` is the only value that
  claims a live vacancy, and Stage 4 is what earns it.

**Technical leadership is third-party personal information, and the schema should
say so.** Store a name, a role title and the URL that listed it — nothing else.
No email, no phone, no LinkedIn scrape, no inference from a pattern like
`first@company.com`. Contact enrichment is out of scope here (§Deliberately not
building) and is where that question belongs, alongside the one this plan does
not answer: the stated goal is bulk outreach, and Australia's Spam Act 2003
governs commercial electronic messages — consent, identification, unsubscribe.
Individual job-seeking contact may well sit outside it; that is worth checking
before the outreach slice rather than after.

---

## Stages

Ordered so each ships something usable and the risky capability arrives late.

### Stage 1 — Companies from the postings already held

**No new tool, no new agent, no network call, no credential.** The `postings`
table already accumulates every advertisement every briefing has found, each
carrying a `company` string and a `url`. Project distinct companies out of it.

This is deliberately the first slice because it exercises the entire spine —
migration, `companyId()`, the upsert, the dashboard page — against data that
already exists, and it produces a real list on day one.

- Migration `0007_companies` (§Schema below).
- `companyId()` in `@workspace/agents`, beside `posting-id.ts`, with its tests
  asserting the key-segment property against `@workspace/user-storage`'s
  predicate as `posting-id.test.ts` does.
- `recordCompanies` in `packages/db/src/companies.ts`, modelled line for line on
  `recordPostings` (`packages/db/src/postings.ts:108-149`) — one raw statement,
  `ON CONFLICT (user_id, company_id)`, the `DO UPDATE SET` list omitting
  `status`, `status_changed_at`, `first_seen_at` and `first_seen_run_id`, and the
  trailing `WHERE EXCLUDED.last_seen_at >= companies.last_seen_at`.
- A script under `apps/briefing-worker/src/scripts/` that walks a user's
  `postings` and records the companies, the same way the postings backfill was
  done.

⚠️ **The company's website is not in `postings`.** A posting URL is
`seek.com.au/job/123`, not the employer's site, so Stage 1 rows carry a name and
no host — which the identity rule cannot hash. Two honest options: key those rows
on a normalised _name_ under a different id prefix, or leave them unrecorded and
let Stage 2 discover them properly. **Take the second.** A company whose website
is unknown cannot be enriched, ranked or contacted, so a row for it is a row that
does nothing but look full. Stage 1 records only companies whose site a posting
actually revealed, and reports how many it skipped.

Done when: the table exists, the ids are stable across two runs of the script,
and `pnpm test` passes with `stores.test.ts` covering the upsert's four
load-bearing omissions.

### Stage 2 — The Prospector, on search alone

The agent, its findings contract, and directory search. No page reading yet.

- `CompanyFindingsSchema` in `packages/agents/src/company-findings.ts`, split
  into a reported shape (names companies by catalog id) and a stored shape
  (carries the URL), exactly as `findings.ts:76-108` splits `ScoutPosting` from
  `Posting`.
- `createProspector()` in `packages/agents/src/prospector.ts` — a factory, never
  an instance, because building one constructs a model that reads
  `OPENAI_API_KEY`.
- A `submit_companies` tool mirroring `submit-findings.ts`: the hand-off is a
  validated tool call, so the provider rejects a malformed one and the model
  retries, rather than a final message failing the whole run.
- Search via the existing `webSearch`, whose `includeDomains`
  (`web-search.ts:203-208`) is what makes directory sweeps targeted rather than
  hopeful.

**The source list is config, not code.** Starting set, chosen for the AU/remote
brief: Startmate, Antler AU, Blackbird, AirTree and Square Peg portfolio pages;
Techboard and Startup Daily; Y Combinator's public company directory filtered on
location. **Crunchbase and LinkedIn are named here only to be ruled out** —
both are auth-walled and largely JS-rendered, so a search result for one is a
title and a paywall, and Stage 3's extract will return nothing useful from
either. Do not spend a stage discovering that.

Done when: a run against a fixed search fake produces validated Company Findings,
an id no search returned is dropped, and the run records rows.

### Stage 3 — The extract tool, and the columns that need it

`packages/agent-tools/src/page-read.ts` per §Decision 2, plus the fields it
unlocks: what they do, location, `ai_core` with evidence, `careersUrl` where an
id exists for one, and leadership names.

Done when: the tool is exercised with a fake `fetch` in the manner of
`web-search.test.ts`, a rejected key throws, every other failure returns a
string, oversized content is truncated visibly, and the Prospector demonstrably
holds no candidate background anywhere in its construction.

### Stage 4 — The hiring signal, from tools that already exist

The strongest available evidence that a company is hiring is an open
advertisement, and this repo holds three live board tools —
`JOB_SCOUT_SEARCH_TOOL_NAMES` (`packages/agents/src/job-scout.ts:79-83`). SEEK in
particular is the AU market.

Two ways to spend it, and the cheap one is better: rather than giving the
Prospector three more tools — a model picks worse as its tool list grows, which
`job-scout.ts:109-127` states as the reason the Scout carries what it does — run
the check in the worker after the Prospector reports, one board search per
company name, and write `hiring` from the result. Deterministic, no extra model
calls, no extra turns to budget for.

Done when: a company with a live advertisement records `open-roles` with the
advertisement's URL as evidence, and a board search that errors records
`unknown` rather than `none`.

### Stage 5 — On a cadence, and on the dashboard

**Blocked on `docs/job-kind-registry-plan.md` shipping.** Then:

- `company-discovery-config.ts` in the worker and one registry line.
- `run-discovery.ts`, taking its agent, its recording callbacks and its trace
  sink through injectable seams, as `RunBriefingInput` does — so a run is
  exercisable with no key, no database and no AWS.
- `/companies` in the dashboard: a server-paginated table with a status control
  and a detail dialog, copied from `apps/dashboard/lib/postings/` and
  `app/(app)/briefings/page.tsx`, which is the same page against a different
  table.

Done when: a discovery job runs on the hourly tick, fails distinguishably on a
bad config, and its rows render.

---

## Schema — `0007_companies`

Forward-only, like every migration here, and applied by
`.github/workflows/migrate.yml` on push to `main`.

```
companies
  id                  UUID PK default gen_random_uuid()
  user_id             UUID NOT NULL  → users(id) ON DELETE RESTRICT
  company_id          TEXT NOT NULL  CHECK ~ '^[0-9a-f]{16}$'
  name                TEXT NOT NULL
  website             TEXT NOT NULL          -- the normalised origin, not a page
  location            TEXT
  summary             TEXT                   -- what they do, two or three sentences
  ai_core             TEXT NOT NULL DEFAULT 'unknown'
                        CHECK IN ('core','applied','none','unknown')
  ai_evidence         TEXT
  hiring              TEXT NOT NULL DEFAULT 'unknown'
                        CHECK IN ('open-roles','careers-page-only','none','unknown')
  hiring_evidence     TEXT
  hiring_checked_at   TIMESTAMPTZ
  careers_url         TEXT                   -- absent unless resolved from an id
  payload             JSONB NOT NULL         -- the validated Company as reported
  status              TEXT NOT NULL DEFAULT 'new'
                        CHECK IN ('new','shortlisted','contacted','rejected')
  status_changed_at   TIMESTAMPTZ            -- NULL until a person moves it
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  first_seen_run_id   UUID NOT NULL  → runs(id) ON DELETE RESTRICT
  last_seen_run_id    UUID NOT NULL  → runs(id) ON DELETE RESTRICT

  UNIQUE (user_id, company_id)
  CHECK (last_seen_at >= first_seen_at)
  INDEX (user_id, last_seen_at DESC, company_id DESC)
```

Notes that are decisions rather than description:

- **`company_id` is the derived id, not this row's `id`** — the same arrangement
  `0005_postings/migration.sql:34-36` explains, and for the same reason: it is a
  potential S3 key segment, so the CHECK says the database must not hold a value
  that could not be one.
- **`payload` is opaque here**, as `runs.findings` and `jobs.config` are. The
  columns above it are the projection the table sorts and displays on; one
  statement writes both, so they cannot drift.
- **Leadership is in `payload`, not in columns.** It is a list of a few
  `{name, role, sourceUrl}` objects that nothing sorts, filters or joins on —
  the exact test `0001_init/migration.sql:3-4` sets. Promote it if a UI ever
  filters on it.
- **Restrict, never cascade**, per `0001_init`. A Company names the Runs that
  found it, so deleting one should fail loudly rather than erase the provenance.
- **The table is created empty and no SQL backfill is possible**, for the reason
  `0005_postings` gives: `companyId()` has exactly one implementation, in
  TypeScript, and a reimplementation in SQL that disagreed by one rule would mint
  ids nothing else in the system agrees with.

---

## Verification

```bash
pnpm turbo typecheck --filter=@workspace/agents --filter=@workspace/agent-tools
pnpm turbo test --filter=@workspace/db
pnpm test
```

Read the lint output rather than its exit code — `eslint-plugin-only-warn`
downgrades every rule, so `pnpm lint` exits 0 regardless.

Two gaps to state rather than discover:

- **`stores.test.ts` skips itself when `DATABASE_URL_UNPOOLED` is unset.** A
  clean local `pnpm test` does not exercise the upsert, the CHECKs or the unique
  index. Only CI, with a database, does.
- **`turbo test` cannot catch an unapplied migration, by construction.** The
  suite replays migrations into a throwaway schema; drift belongs to the
  environment. `migrate.yml` is what applies `0007_companies`.

The success criterion is not a passing suite. It is this: **a hundred rows a
person can read down without wanting to delete half of them.** A discovery run
that returns forty companies of which twelve are consultancies, six are dead
links and four are the same company under different hosts has failed at the thing
it exists to do, however green the tests are.

---

## Deliberately not building

- **Contact enrichment.** Emails, phone numbers, LinkedIn profiles. It is the
  next slice and it is the one with the legal question in it (§Decision 6).
- **Ranking by fit.** It needs the candidate's background, and §Decision 2 keeps
  that away from anything that reads pages. Ranking is a separate pass over
  stored rows, by an agent that reads no page and holds no URL — a clean
  separation, and a reason to build it second rather than to smuggle it in here.
- **Outreach.** Drafting, sending, tracking replies. `OVERVIEW.md` records that
  even _sending a cover letter_ has no code at all; outreach is further out.
- **A merge tool for duplicate hosts.** §Decision 3 accepts visible duplicates on
  purpose.
- **Crunchbase or LinkedIn as sources.** §Stage 2 rules them out.
- **A general HTTP fetcher.** §Decision 2 option (c).
- **Any change to `infra/aws/`.** §Decision 5 is what avoids one.

---

## The riskiest assumption

That a model reading a startup's own marketing copy can tell whether AI is core
to the product.

Every startup site in this market says "AI-powered". The word is free, and a
company that fine-tunes models and a company that calls one API both write the
same landing page — so `ai_core` risks reading `core` for the whole list, at
which point the column filters nothing and the list is not clean, merely long.
`ai_evidence` exists because of this: a quoted sentence is checkable by a person
in a second, and a column of quotes that all say "AI-powered platform" makes the
failure visible on the first read rather than after outreach.

The tripwire worth naming now: **if the first real run returns `core` for more
than about half the list, the judgement is not working** — and the answer is
probably a narrower question (does the product's core function require a model at
inference time?) rather than a better prompt.

---

## Open questions

- **Does `createPostingCatalog` generalise, or does the company catalog copy
  it?** The shape is identical and only the entry type differs. Generalising
  touches a file three board tools depend on; copying accepts a second
  implementation of a small thing. Stage 2 decides.
- **Does the extract tool record discovered links into the catalog?**
  §Decision 4 assumes it does, which is what makes a careers page reportable.
  It also means one page read can add dozens of catalog entries, so it needs a
  cap and a rule for which links are worth keeping.
- **One discovery job per user, or one per thesis?** "AI startups in Melbourne"
  and "remote-first infra companies" are different searches with different source
  lists. Rows are cheap and `companies` is keyed on (user, company) either way,
  so several jobs converge on one list — which is an argument for allowing it and
  no work to support.
- **Should `hiring` decay?** `hiring_checked_at` is on the table so that a value
  can be read as stale, but nothing recomputes it and nothing renders the age. A
  company that was hiring in March and is listed as hiring in August is a wrong
  answer that looks like a right one.
