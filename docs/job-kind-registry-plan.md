# Job kinds — a dispatch registry for the worker

## Context

The platform is a scheduler with four nouns — users, jobs, runs, artifacts
(`packages/db/prisma/migrations/0001_init/migration.sql`) — an hourly tick that
asks Postgres what is due, and a private per-user S3 bucket for what the runs
produce. The job-search briefing is one instance of that machinery. The
repository is called `control-panel` for a reason.

`apps/briefing-worker/src/job-search-config.ts:9-12` states the intended
property:

> Keeping the schema out of the database package is what lets a second kind of
> job arrive later with a completely different config and no migration.

Half of that is already true. `@workspace/db` genuinely never reads inside the
column: `packages/db/src/jobs.ts:53` casts `config` through as
`Prisma.InputJsonValue`, `packages/db/src/types.ts:17` types it as an opaque
`Record<string, unknown>`, and the column is bare
`JSONB NOT NULL DEFAULT '{}'` (`0001_init/migration.sql:29`). There is no
`kind`, `type` or `handler` column anywhere in the schema.

The other half is not. **Nothing dispatches.** This plan adds the missing half
and nothing else.

---

## Where the code contradicts the brief

Four facts, each verified against the code rather than the docs.

**1. The seam is a bare function call.** `apps/briefing-worker/src/run-tick.ts:106`
calls `runBriefing(...)` unconditionally, for every due job, with no branch. That
single line is the entire distance between "a job is due" and "a briefing runs".

**2. A foreign config fails late, not early.** `runBriefing` calls
`parseJobSearchConfig` as its first step (`run-briefing.ts:200`), which throws on
anything not job-search shaped (`job-search-config.ts:69-75`). So a job row with
a different config today would be selected by `dueJobs`, have its `next_run_at`
advanced, get a `running` row inserted by `claimJob`, fail at config parse, be
marked `failed`, and make the whole tick rethrow (`run-tick.ts:137-143`). It
burns a slot to discover something knowable before the slot was claimed.

**3. `run-tick.ts` has no test.** The worker's only tests are
`run-briefing.test.ts` and `search-results.test.ts`. `runTick` takes a concrete
`PrismaClient`, which is awkward to fake — which is why it has none, and why the
dispatch decision needs to be testable without one.

**4. The Errors alarm is daily and latching, not per-invocation.**
`infra/aws/modules/briefing-worker/monitoring.tf:16-30` sets `period = 86400`
with `threshold = 1` and `Sum` statistic. So a job that fails every hour does not
produce hourly pages — it produces one alarm that never returns to OK, because
no 24-hour window is ever error-free. **That is worse than noise.** A latched
alarm cannot signal the next real failure, so one unhandled job kind silently
disables the only mechanism that tells anyone the worker is broken.

That fourth fact is what decides Decision 3 below, and it is the reason this
work is worth doing before a second kind exists rather than alongside it.

---

## The five decisions

### 1. The discriminator lives in `config`, and absent means the briefing

`config.kind`, a string, optional. Absent is not a missing value to be
back-filled — it is the briefing kind, permanently.

The alternative is a real `jobs.kind` column. The schema's own organising rule
(`0001_init/migration.sql:3-4`) is that pipeline-shaped things live in
`jobs.config` and anything the platform *queries, filters, sorts or constrains*
is a real column. Nothing queries or filters on kind: `dueJobs` orders on
`next_run_at` (`packages/db/src/jobs.ts:72-78`) and the tick runs whatever comes
back. The worker reads the discriminator once, in memory, having already
fetched the row.

What decides it is the live data. There are existing rows whose config has no
discriminator at all, and a column would need either a `DEFAULT` that encodes a
product decision in DDL or a backfill — and migrations here are forward-only
with no down migration (`0001_init/migration.sql:6`). Absent-means-briefing
costs neither, and it is the reading that stays correct if the platform is ever
pointed at a database it did not create.

**What this costs, stated plainly:** the discriminator is invisible to ordinary
SQL. "How many weather jobs do I have" becomes a JSONB expression rather than a
`WHERE`. That is acceptable while the answer is a handful of rows a single user
owns, and it is the thing to revisit first if kinds proliferate — see §The
riskiest assumption.

### 2. A handler receives a context, not a parameter list

`runTick` today takes `briefs: BriefStore` (`run-tick.ts:68`) and threads it into
`runBriefing`. The naive dispatch keeps that signature and hands every handler a
`BriefStore`. That would dispatch without decoupling anything: a kind that
writes no brief would still be handed the authority to write one, and the second
kind that needs a different store would add a second parameter to `runTick`,
then a third.

So the registry entry receives a context object assembled once per tick — the
job, the claimed slot, and the recording callbacks `runTick` already builds
(`run-tick.ts:110-113`) — and each handler reaches for what it needs. The
briefing handler is a thin adapter over `runBriefing`, whose own injectable-seam
shape (`RunBriefingInput`, `run-briefing.ts:90-129`) is already the pattern to
copy: dependencies arrive as fields, not positional arguments, precisely so a
test can supply a subset.

The open part is how a *future* kind's store reaches it without `runTick`
constructing every store on every tick, most of which no due job will use.
Construction is not free — `createBriefStore(createS3UserObjectStore())`
(`apps/briefing-worker/src/index.ts:147`) reads `USER_STORAGE_BUCKET_NAME` and
`USER_STORAGE_ENVIRONMENT` and throws without them. Lazy per-kind construction is
the likely answer; it does not have to be built now, but the context shape must
not foreclose it.

### 3. An unknown kind fails the run and does not claim the slot

Two failure modes must stay distinguishable in `runs.failure`:

- **this job names a kind nothing handles** — a deployment or data fault, not
  fixable by retrying
- **this job's config is malformed for its kind** — what
  `parseJobSearchConfig`'s message already says today

Today both would read as the second, because there is only one path.

The kind lookup happens **before `claimJob`**. An unhandled kind is knowable from
the row alone, and claiming a slot to discover it advances `next_run_at`, inserts
a `running` row, and consumes the occurrence — for a job that had no chance of
running. The tick's existing `skipped` counter (`run-tick.ts:44-46`) is for
slots another party holds and should not be borrowed for this; an unhandled kind
is a fault and must be visible as one.

Which leaves the question fact 4 forces: this failure recurs every hour forever
and will latch the Errors alarm, destroying the signal for every other failure.
The honest options are (a) fail the run and accept the latch, (b) fail the run
and pause the job, (c) report it distinctly and do not throw. **This plan takes
(a)**, and records why: (b) is failure quarantine, which is a policy engine with
its own resume story and is out of scope here; (c) breaks the throw contract that
`runTick`'s own comment (`run-tick.ts:60-65`) identifies as what the alarm
depends on. The latch is a real cost, it is written down here, and it is the
argument for building quarantine next.

### 4. The dashboard writes nothing new

`apps/dashboard/lib/jobs/job-actions.ts:239` writes `config: criteria.data` on
create. Under Decision 1 that config has no `kind` and therefore means the
briefing kind, which is correct, so **no dashboard change is required and none
should be made.**

This matters because `apps/dashboard/lib/jobs/search-criteria.ts:6-25` already
documents a knowing duplication of part of the worker's schema, and closes with:
"changing the worker's required fields means changing this file too." Requiring
an explicit `kind` would make the discriminator a *required* field and drag that
file — and its warning — into scope for no gain.

### 5. `runTick`'s throw contract is untouched

Every due job is still attempted, each failure is still recorded to its row and
carried, and the tick still rethrows at the end. That behaviour is what produces
the Lambda `Errors` datapoint (`run-tick.ts:60-65`,
`modules/briefing-worker/monitoring.tf:13-15`). Nothing in this work is a reason
to swallow an error, and a change that makes the tick exit cleanly on a failed
job is a regression regardless of how much tidier it reads.

---

## Stages

### Stage 1 — the registry, one entry, no behaviour change

A pure function from a config bag to a handler, and a registry with exactly one
entry: the briefing. The briefing handler is an adapter over `runBriefing` that
changes nothing about how a briefing runs.

`runTick`'s body loses its bare `runBriefing` call and gains the lookup. The
registry is injectable — the same seam idea as `createScout` / `createWriter` in
`RunBriefingInput` — so the dispatch can be exercised without a Prisma fake.

The registry lives in the worker. It must not go in `@workspace/db`: the opacity
of `jobs.config` is the platform's organising rule, and a database package that
knows what kinds exist has stopped being opaque.

Done when: every existing job behaves identically, `run-briefing.test.ts` passes
unchanged, and a new test proves a config with no discriminator routes to the
briefing handler.

### Stage 2 — the unknown-kind path

The lookup moves ahead of `claimJob`, and an unhandled kind produces a failure
whose message names the kind and does not resemble a config-parse failure. Slot
untouched.

Done when: a test proves an unknown kind fails distinguishably, and proves no
slot was claimed for it.

### Stage 3 — prove the seam with a fake

A test-only second kind, registered in a test and nowhere else, proving the
registry routes to something that is not the briefing.

**No real second kind is built here.** A registry with one real entry plus a test
fake is a finished refactor with no speculative surface; one with a half-built
weather job is two unfinished things.

---

## Verification

```bash
pnpm turbo typecheck --filter=@workspace/briefing-worker
pnpm turbo test --filter=@workspace/briefing-worker
pnpm turbo lint --filter=@workspace/briefing-worker
```

`lint` exits 0 regardless — `eslint-plugin-only-warn` is in the base config, so
every rule is a warning. Read the output; the exit code says nothing.

Run the full `pnpm test` if anything outside the worker is touched. Note that
`@workspace/db`'s `stores.test.ts` skips itself when `DATABASE_URL_UNPOOLED` is
unset, so a clean local run does not exercise the claim race.

If `apps/briefing-worker/src/dev/cli.ts` (the `pnpm watch` harness) drives a
briefing through a changed path, it keeps working.

The success criterion is not a passing suite. It is this: **adding the second
job kind costs one config schema, one run function, and one registry line.** If
it costs more, the seam is not finished.

---

## Deliberately not building

- **A second real job kind.** Stage 3 says why.
- **Failure quarantine, auto-pause, budget ceilings.** Decision 3 leans on this
  existing and it does not; that is the argument for building it next, not for
  smuggling it in here.
- **An ad-hoc run trigger or a runs history page.** Separate work, and the
  higher-value work — nothing currently renders a `runs` row at all.
- **A new object kind.** `packages/user-storage/src/kinds.ts` needs a matching
  `object_kinds` entry in `infra/aws/modules/user-storage/variables.tf` or the
  objects get no retention and writes 403 for want of the per-kind grant.
  Terraform is manual and outside Turborepo.
- **Any change to `infra/aws/`.**
- **Any new agent, tool or credential.** Each credential is a `loadSecret` call
  in `apps/briefing-worker/src/index.ts:88-115` plus a hand-set Secrets Manager
  shell.

---

## The riskiest assumption

That a discriminator inside JSONB is enough, and that the pressure to promote it
to a column will announce itself.

It will not announce itself loudly. Nothing breaks when kind lives in `config`;
things merely get slightly harder, one query at a time, and the moment to
migrate passes unnoticed. The concrete tripwires worth naming now:

- **Observability across kinds.** The tick report (`run-tick.ts:37-49`) counts
  due, claimed, skipped, succeeded and failed with no breakdown by kind. Two
  kinds in, "which kind is failing" is unanswerable from the logs.
- **Anything the dashboard filters on.** The moment a UI wants "show me only my
  watchers", kind has become something the platform queries, which is the exact
  test `0001_init/migration.sql:3-4` sets for a real column.
- **Per-kind scheduling policy.** A per-kind concurrency cap or timeout budget
  needs kind in a `WHERE`.

None of these is true today with one kind, and a column added now would be a
column added on speculation. But the promotion is a forward-only migration plus a
backfill from JSONB, and it gets more expensive with every row — so it is worth
doing deliberately at the second or third kind rather than at the tenth.

---

## Open questions

- **Does the briefing handler own `parseJobSearchConfig`, or does `runBriefing`
  keep calling it?** Moving it up makes a malformed config knowable before the
  claim, matching what Decision 3 does for an unknown kind — but it changes
  `runBriefing`'s contract, and `run-briefing.test.ts` asserts against the
  current one. Stage 1 leaves it alone; the answer belongs with Stage 2.
- **Should a kind declare its Zod schema to the registry?** It would let the tick
  validate before claiming, uniformly, for every kind. It also couples the
  registry to Zod, which the worker already depends on but the pattern need not
  assume.
- **How does a lazily-constructed store reach a handler** without `runTick`
  building every store on every tick? Decision 2 defers this; the constraint is
  only that the context shape must not make it impossible.
