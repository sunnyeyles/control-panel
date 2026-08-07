# @workspace/briefing-worker

An AWS Lambda invoked **hourly** by EventBridge Scheduler. It is not "the thing
that runs at 09:00" — it is "the thing that runs every hour and asks what is
due".

Each invocation is a **tick**: it loads its secrets, asks `@workspace/db` which
jobs have reached their slot, claims each one, runs it, and records the outcome.
A tick that finds nothing due is a success.

A job's own cadence lives in Postgres, as `jobs.schedule_cron` and
`jobs.schedule_timezone`; what stayed in Terraform is the tick. `CONTEXT.md`
§Tick has the reasoning.

The work a claimed job performs is a **briefing run**: a scout agent searches
SEEK's live listings for postings matching the criteria in `jobs.config`, a
writer agent turns those findings into markdown, the worker uploads it to
private S3 through `@workspace/user-storage`, records the object key in
`artifacts`, keeps the findings themselves on the run row, and adds every
posting it found to the cumulative `postings` record. Live listings rather than
web search, deliberately: a search engine's index carries a board's browse
pages, not its postings, and the posting URLs it does surface are often expired
— the live inventory is what makes every URL in a brief a page someone can
actually open.

The two agents are joined by plain TypeScript rather than by a LangGraph
fan-out. Fanning out across several scouts and merging their findings is a later
change, and it does not disturb this shape — it replaces what produces
`findings` and leaves everything downstream alone. What matters now is that the
scout hands over **data**, because data is the thing that can be validated
between the two halves.

## Layout

```
src/index.ts               shallow — the Lambda handler, and the only AWS-aware file
src/run-tick.ts            deep — claim, run, record; one invocation's worth of work
src/run-briefing.ts        deep — owns one briefing and its success contract
src/run-agent.ts           deep — drives one agent, watching it work
src/job-search-config.ts   deep — what `jobs.config` means to this worker
src/search-results.ts      which tool results count as searches, and from where
src/resolve-postings.ts    deep — the reported id → the URL the board issued
src/trace.ts               the run's event stream, and where it can be sent
src/dev/                   the local harness. Never bundled, never deployed.
build.mjs                  esbuild bundle + deploy-root assembly
```

The split is the point of the design: neither `run-tick.ts` nor
`run-briefing.ts` knows where it runs, so both are testable and portable.
Everything platform-shaped — the handler signature, fetching secrets, and
reaching S3 — lives in `index.ts`.

`runTick` takes a `PrismaClient` and a `BriefStore` rather than constructing
either, for the same reason.

**`jobs.config` is interpreted here, not in `@workspace/db`.** The platform
stores that column and never reads inside it, so the schema for it lives in
`job-search-config.ts`. That is what lets a second kind of job arrive later with
a completely different config and no migration — and it is the seam a resume
extractor will eventually write to, with nothing downstream of it changing.

**Due jobs are run sequentially in one invocation.** Fanning out would mean a
second Lambda, a second set of permissions and a second failure mode, bought to
parallelise a list that is usually empty. The function timeout bounds it, and
`dueJobs()` is limited, so a backlog is worked oldest-slot-first across several
ticks rather than attempted all at once.

The schedule is **not** in this package. It lives in
`infra/aws/modules/briefing-worker/schedule.tf`, which keeps the tick reviewable
in a diff rather than drifting invisibly in console configuration.

## Two off-switches, at different scopes

Neither is in this package either, and confusing them wastes an afternoon.

| Off                     | Mechanism                                          | Changed by                                                          |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| The tick, for every job | `schedule_enabled` → EventBridge Scheduler `state` | `terraform apply -var="schedule_enabled=false"`, see `DEPLOYING.md` |
| One job                 | `jobs.next_run_at IS NULL`                         | The dashboard's `/settings`, or `pauseJob()`                        |

A job is off when it has no `next_run_at` — there is no `enabled` column, and
`packages/db/prisma/migrations/0001_init/migration.sql` explains why one absence covers both
paused and retired. `dueJobs()` filters on a partial index over exactly that
predicate, so a paused job is not merely skipped, it is absent from the index
the tick reads.

The consequence worth remembering: a tick reporting `"due":0` proves nothing
about whether the schedule is enabled, and an enabled job proves nothing about
whether the tick will ever wake to notice it. Check both before concluding the
worker is broken.

## Connections and secrets

Three secrets, all fetched from Secrets Manager at cold start and cached at
module scope: `OPENAI_SECRET_ID`, `DATABASE_SECRET_ID` and `APIFY_SECRET_ID`.
No value is a Lambda environment variable — that would put it in plan output, in
state, and on the console's function configuration page.

Two things that are **not** secrets are passed directly:
`USER_STORAGE_BUCKET_NAME` and `USER_STORAGE_ENVIRONMENT`, which is what
`createS3UserObjectStore()` reads. `AWS_REGION` needs no entry — the Lambda
runtime sets it, so the region the function runs in and the region it writes to
cannot become two facts that disagree.

The **connection** is deliberately not cached that way. A secret is a string and
stays valid; a socket does not. The gap between ticks is an hour and Neon
autosuspends after five minutes, so a reused connection is dead by the next
invocation as the default outcome — hence one `createPrismaClient()` per invocation,
closed in a `finally`.

Migrations do not run here. Every cold start would race every other one for a
schema it does not need; see `packages/db/README.md`.

## Commands

```bash
pnpm turbo build --filter=@workspace/briefing-worker      # bundle to dist/
pnpm turbo typecheck --filter=@workspace/briefing-worker
pnpm --filter=@workspace/briefing-worker test             # run logic, fake agents
pnpm turbo zip --filter=@workspace/briefing-worker        # dist/ -> lambda.zip
pnpm --filter=@workspace/briefing-worker invoke           # run the handler locally
pnpm --filter=@workspace/briefing-worker watch            # watch one briefing, step by step
pnpm --filter=@workspace/briefing-worker letter           # draft a cover letter for one Posting
```

Running locally needs no emulator, no AWS credentials and no local host — only
the values the function would otherwise fetch, plus the two storage variables:

```bash
export OPENAI_API_KEY=...
export DATABASE_URL=...                  # the pooled endpoint
export APIFY_TOKEN=...
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_BASE_URL=https://cloud.langfuse.com
export USER_STORAGE_BUCKET_NAME=...
export USER_STORAGE_ENVIRONMENT=prod
export AWS_REGION=ap-southeast-2
pnpm turbo build --filter=@workspace/briefing-worker
pnpm --filter=@workspace/briefing-worker invoke
```

The secret part works because `loadSecret()` short-circuits when the target
variable is already set, so the Secrets Manager call never happens. It is also
the escape hatch if Secrets Manager is unreachable but the values are known.
Writing to S3 is the one step that does need real credentials, since the upload
is a real upload.

### Langfuse traces

The Lambda records each briefing as one `generate-briefing` trace. It retains
the search criteria, agent prompts and outputs, tool I/O, and generated brief;
use a Langfuse project whose retention and access controls permit that content.
`LANGFUSE_BASE_URL` defaults to the EU cloud endpoint in Terraform; set
`briefing_worker.langfuse_base_url` for a different Langfuse region or a
self-hosted instance.

Every invocation prints one JSON `tick` line — `due`, `claimed`, `skipped`,
`succeeded`, `failed` — and one `briefing-run` line per job that was actually
claimed. A tick with `"due":0` is a success and exits 0. Any failed job makes
the process exit non-zero, which is what produces the `Errors` datapoint the
alarm watches.

The unit tests need none of the above. They drive `runBriefing` with fake agents
through its `createScout`/`createWriter` seams and assert on the shape of a run —
did a search succeed, did the hand-off validate, is the key derived from the
occurrence — never on what a model said.

## Watching a run

`invoke` runs the real handler, and the real handler **claims a slot**. Claiming
is at-most-once by design, so using it to see what a job does consumes that
job's occurrence, writes a real object and spends real money. Debugging should
not cost the thing being debugged.

`watch` exists for that. It drives `runBriefing` directly — no claim, no `runs`
row, no `next_run_at` advance, no S3 and no AWS credentials — and renders the
run as it happens: the prompt each agent got, every search query with what came
back, the findings as they validated, and the brief.

```bash
export OPENAI_API_KEY=... APIFY_TOKEN=...
pnpm --filter=@workspace/briefing-worker watch --config ./fixtures/example-search.json
```

The model and the SEEK search are real, because they are the parts worth
watching. Everything else is local: the brief lands under `.briefings/` at the
key S3 would have used, the validated findings land beside it as `.json`, and
the trace is kept under `traces/` as JSON lines.

```
--config <path>  search criteria to run, as a jobs.config payload. No database.
--job <uuid>     take the criteria from a real job row, read-only. Needs DATABASE_URL.
--at <iso>       the slot to run for, which decides the key's partition day.
--out <dir>      where the brief, its findings and the trace land. Default ./.briefings
--json           print the raw trace as JSON lines instead of rendering it.
--verbose        do not truncate messages or tool results.
```

The findings file is a **file, not an object**: it is the brief's own key with
`.json` in place of `.md`, so it sits literally beside the markdown, but there
is no `findings` object kind and S3 would not accept the key. Production keeps
a run's findings on the `runs` row; the harness writes no row, so on disk is the
only place left — and it is what `letter` below reads.

`--job` reads the row and nothing more. It does not claim it, advance its
schedule, or create a run — the job stays exactly as due as it was.

**The trace is a seam, not a log format.** `runBriefing` takes an optional
`trace` sink (`src/trace.ts`) and emits every step boundary, model message and
tool round trip through it; the terminal renderer under `src/dev/` is one
consumer, `--json` is another, and a run with no sink behaves exactly as it did
before the seam existed, down to the log lines. Persisting a trace beside the
brief, or streaming one to the dashboard, is a third consumer and needs nothing
new here.

What made this possible is a two-line change in `run-briefing.ts`: the agents
are driven with `.stream()` instead of `.invoke()`. `.invoke()` runs the graph
to completion and returns the final state, discarding the queries, the results
and the turns it took to get there — which is why `countToolResults` has to
re-derive a search count by filtering the finished message array. `.stream()`
yields the same run one superstep at a time and returns the same final state.
`@workspace/agents-core` and the agents themselves are untouched.

Nothing under `src/dev/` is reachable from the deployed bundle: `build.mjs`
takes `src/index.ts` as its only entry point, so the harness cannot ship even by
accident.

## Drafting a cover letter

`letter` drafts one cover letter for one **Posting**, from a Findings file and a
document the candidate wrote, and puts it on disk. It exists to answer whether
such a letter is worth the surface it would need — storage, a dashboard, an
object kind, an IAM grant — **before** any of that is built. Nothing it touches
is a step toward that surface: no S3, no database, no migration.

```bash
export OPENAI_API_KEY=...
pnpm --filter=@workspace/briefing-worker letter \
  --findings ./fixtures/example-findings.json --list

pnpm --filter=@workspace/briefing-worker letter \
  --findings ./fixtures/example-findings.json \
  --profile ./fixtures/example-profile.md \
  --posting 1 --name "Alex Rivers"
```

Point `--findings` at the JSON a `watch` run wrote beside its brief for real
input; the fixture is a hand-transcribed copy of two live SEEK advertisements,
for when re-running a search is not worth it. `fixtures/example-profile.md` is
an **invented** candidate — the roles, the employers and the numbers in it never
happened, and it is there so the CLI has something to read.

- `--profile` takes `.md` or `.txt` only. A PDF needs a text extractor this does
  not have, and a parser that quietly returned the wrong text would put invented
  substance in a letter signed by the user.
- `--posting` takes the number from `--list`, a posting id, or a distinctive
  substring. A substring matching two Postings is refused rather than resolved
  to the first.
- The letter is printed as well as written, because reading it is the point.

**The writer has no tools, and that is the security property.** It holds the CV
in its context while the Posting beside it is text anyone who pays for an
advertisement controls — copied into the prompt verbatim, hidden instructions
and all. Tool-lessness is what makes copying acceptable. Do not give this agent
a fetch tool; when a page fetcher exists it goes on a separate agent that never
sees the profile. See `packages/agents/README.md`.

**It refuses before spending anything.** `assertDraftable()` rejects a profile
that is absent, under 200 characters or over 20,000 — the last of those rather
than truncating, because a letter written from half a CV with nothing saying so
is indistinguishable from one written from all of it. A missing fact — a start
date, a salary, a recipient's name — comes back as a literal
`[bracketed placeholder]`, never as a plausible invention.

Letters land under `.letters/`, which is git-ignored.

## Forcing a run in AWS

The handler takes a payload, and **an absent `kind` means the tick** — which is
what EventBridge Scheduler sends and what this has always done:

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

The other shape runs **one** briefing, out of band. It is what the dashboard's
**Run now** button sends, and the `runs` row must already exist — this claims a
row rather than creating one, so a hand-written payload naming a row that is
finished, or already claimed, correctly does nothing:

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out \
  --payload '{"kind":"ad-hoc-run","runId":"<runs.id>","jobId":"<jobs.id>"}' \
  /dev/stdout
```

A payload carrying an unrecognised `kind` throws rather than falling through to
the tick — running every due job because a discriminator was misspelt is a
worse outcome than a failed invocation.

Unlike the tick, an ad-hoc run that fails **does not throw**, so it produces no
`Errors` datapoint and does not trip the alarm. Its outcome is on the `runs` row
and in its own `"event":"ad-hoc-run"` log line.

Read the result in CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /"event":"tick"/ or @message like /"event":"briefing-run"/ or @message like /"event":"ad-hoc-run"/
| sort @timestamp desc
| limit 40
```

Every `briefing-run` line carries `"trigger"`, which is `"schedule"` or
`"manual"` — `scheduledFor` no longer tells them apart, because an ad-hoc run
files under the instant it was requested. Filter on it to answer "is it the
schedule that is failing, or the button".

A healthy hour with nothing scheduled is one `tick` line with `"due":0` and no
`briefing-run` line at all — which is why the tick line exists. When a job does
run, good looks like `"outcome":"success"` with `"searches"` above zero and an
`objectKey`. The search count is the number that matters: a run that reached the
model but made no successful search would be reporting postings it did not look
up, so the run fails rather than producing one.

`"skipped"` above zero is not an error. It means another party already held the
slot — an overlapping tick, or a manual invoke landing mid-tick — and the job
was correctly left alone.

## Things that are load-bearing and look like they are not

**The `createRequire` banner in `build.mjs`.** Some transitive CommonJS in the
LangChain stack calls `require` at load time, which an ESM bundle has no binding
for. It sits among the bundler options and reads like tuning; it is not.
Removing it breaks the bundle at import with an opaque
`require is not defined`.

**`"type": "module"` in the generated `dist/package.json`.** It is what makes
Lambda load `index.js` as ESM and find the named `handler` export. Without it
the runtime treats the bundle as CommonJS and fails at import. There is
deliberately no `main` — Lambda locates the entry from its own
`handler = "index.handler"` setting.

**`dist/` is a deploy root, not compiler output.** The zip is exactly its
contents — in particular never `node_modules`, whose pnpm symlinks do not
survive being zipped. That is why the bundle has no externals at all.

**The brief is written before the row, never after.** The `artifacts` row is the
claim that a brief exists, so `artifacts.record()` runs only once `briefs.put()`
has returned a key. The reverse order leaves a row pointing at nothing.

**`briefId` is the run id, and the partition day comes from `scheduledFor`.**
Two properties fall out of that: re-executing a given run overwrites the same
object rather than making a second one, and two runs can never collide on
`artifacts.object_key`, which is UNIQUE. A 23:30 slot that finishes after
midnight still files under the day its run row names.

**The two accessory records are kept last, and losing either is a warning rather
than a failure.** `runs.findings` is written after the brief exists and its row
is recorded, inside a `try`; the `postings` upsert follows it in a second one,
projected by `src/postings.ts` and written by `recordPostings`. Whichever failed
puts `{ findings: { message } }`, `{ postings: { message } }`, or both, on a
single `SuccessReport.warnings` object — one object rather than a winner, so a
run that lost both says so — which `runTick()` and `runAdHoc()` hand to
`finishRun()` as its third argument: `succeeded` with a non-empty `failure`, the
rule `packages/db/src/types.ts` states. The object is absent entirely when
nothing went wrong, because `finishRun` reads an empty `failure` as a run with
warnings. The rule this does _not_ inherit is "a run with no successful search
fails": that one guards against silent fabrication, and a run that produced a
briefing succeeded whatever happened to the accessory records.

The two are not one record written twice. The findings are what _this_ run
reported and the next run's findings are its own; `postings` is the cumulative
one, which a posting — and the status a person set on it — outlives every
individual run through. `recordPostings` never touches that status, so a failed
upsert costs a sighting and never a decision.

**Nothing else catches the throw.** `runBriefing()` emits its one-line report
and rethrows, `runTick()` records the failure and rethrows after attempting
every other due job, and the handler lets it through. That throw is what marks
the invocation failed, which is what produces the `Errors` datapoint the alarm
watches. Catching it would turn a broken run into a silent one — and writing the
`failed` row is not a substitute, because a run that dies before it can write
leaves no row at all.

**A claim that returns nothing means skip the job entirely.** Not run it, not
retry it, not touch the row. Claiming is at-most-once by design and every
duplicate occurrence is a paid LLM run.

**`prisma.$disconnect()` is in a `finally`.** Lambda freezes the process rather
than tearing it down, so a connection left open is one Neon keeps accounting for
while nothing is using it.

**`lambda.zip` is read at Terraform _plan_ time, not apply time.** This package
produces it, so an unbuilt tree breaks a plan; see `infra/aws/README.md`
§Applying it.
