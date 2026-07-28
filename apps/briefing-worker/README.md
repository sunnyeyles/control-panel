# @workspace/briefing-worker

An AWS Lambda invoked **hourly** by EventBridge Scheduler. It is not "the thing
that runs at 09:00" — it is "the thing that runs every hour and asks what is
due".

Each invocation is a **tick**: it loads its secrets, asks `@workspace/db` which
jobs have reached their slot, claims each one, runs it, and records the outcome.
A tick that finds nothing due is a success.

A job's own cadence lives in Postgres, as `jobs.schedule_cron` and
`jobs.schedule_timezone`, so adding a job with a different cadence costs an
INSERT rather than a Terraform apply. What stayed in Terraform is the tick,
which is the same for every job and therefore has nothing left to drift.

The work a claimed job performs is a **briefing run**: a scout agent searches
the web for job postings matching the criteria in `jobs.config`, a writer agent
turns those findings into markdown, the worker uploads it to private S3 through
`@workspace/user-storage`, and records the object key in `artifacts`.

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
src/job-search-config.ts   deep — what `jobs.config` means to this worker
build.mjs                  esbuild bundle + deploy-root assembly
```

The split is the point of the design: neither `run-tick.ts` nor
`run-briefing.ts` knows where it runs, so both are testable and portable.
Everything platform-shaped — the handler signature, fetching secrets, and
reaching S3 — lives in `index.ts`.

`runTick` takes a `Db` and a `BriefStore` rather than constructing either, for
the same reason.

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

## Connections and secrets

Three secrets, all fetched from Secrets Manager at cold start and cached at
module scope: `OPENAI_SECRET_ID`, `DATABASE_SECRET_ID` and `TAVILY_SECRET_ID`.
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
invocation as the default outcome — hence one `createDb()` per invocation,
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
```

Running locally needs no emulator, no AWS credentials and no local host — only
the values the function would otherwise fetch, plus the two storage variables:

```bash
export OPENAI_API_KEY=...
export DATABASE_URL=...                  # the pooled endpoint
export TAVILY_API_KEY=...
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

Every invocation prints one JSON `tick` line — `due`, `claimed`, `skipped`,
`succeeded`, `failed` — and one `briefing-run` line per job that was actually
claimed. A tick with `"due":0` is a success and exits 0. Any failed job makes
the process exit non-zero, which is what produces the `Errors` datapoint the
alarm watches.

The unit tests need none of the above. They drive `runBriefing` with fake agents
through its `createScout`/`createWriter` seams and assert on the shape of a run —
did a search succeed, did the hand-off validate, is the key derived from the
occurrence — never on what a model said.

## Forcing a run in AWS

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

Read the result in CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /"event":"tick"/ or @message like /"event":"briefing-run"/
| sort @timestamp desc
| limit 40
```

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

**Nothing catches the throw.** `runBriefing()` emits its one-line report
and rethrows, `runTick()` records the failure and rethrows after attempting
every other due job, and the handler lets it through. That throw is what marks
the invocation failed, which is what produces the `Errors` datapoint the alarm
watches. Catching it would turn a broken run into a silent one — and writing the
`failed` row is not a substitute, because a run that dies before it can write
leaves no row at all.

**A claim that returns nothing means skip the job entirely.** Not run it, not
retry it, not touch the row. Claiming is at-most-once by design and every
duplicate occurrence is a paid LLM run.

**`db.close()` is in a `finally`.** Lambda freezes the process rather than
tearing it down, so a connection left open is one Neon keeps accounting for
while nothing is using it.

**Build before `terraform plan`.** Terraform reads `lambda.zip` with
`filebase64sha256` at plan time, so a plan on a tree that has not been built
fails with a file-not-found that reads like a Terraform bug.
