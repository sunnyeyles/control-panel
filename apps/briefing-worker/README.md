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

Today the work a claimed job performs is still a **proof task**: it asks an
agent for the current UTC time using a single tool, and its only purpose is to
prove the deployment foundation works end to end — secret delivery, outbound
HTTPS, the built `dist/` of the agent packages resolving at runtime, and a full
model → tools → model cycle through the LangGraph graph. The real briefing
replaces the body of `run-scheduled-task.ts` later; nothing else has to move.

## Layout

```
src/index.ts               shallow — the Lambda handler, and the only AWS-aware file
src/run-tick.ts            deep — claim, run, record; one invocation's worth of work
src/run-scheduled-task.ts  deep — owns the task and its success contract
build.mjs                  esbuild bundle + deploy-root assembly
```

The split is the point of the design: neither `run-tick.ts` nor
`run-scheduled-task.ts` knows where it runs, so both are testable and portable.
Everything platform-shaped — the handler signature and fetching secrets — lives
in `index.ts`.

`runTick` takes a `Db` rather than constructing one, for the same reason.

**Due jobs are run sequentially in one invocation.** Fanning out would mean a
second Lambda, a second set of permissions and a second failure mode, bought to
parallelise a list that is usually empty. The function timeout bounds it, and
`dueJobs()` is limited, so a backlog is worked oldest-slot-first across several
ticks rather than attempted all at once.

The schedule is **not** in this package. It lives in
`infra/aws/modules/briefing-worker/schedule.tf`, which keeps the tick reviewable
in a diff rather than drifting invisibly in console configuration.

## Connections and secrets

Two secrets, both fetched from Secrets Manager at cold start and cached at
module scope: `OPENAI_SECRET_ID` and `DATABASE_SECRET_ID`. Neither value is a
Lambda environment variable — that would put it in plan output, in state, and on
the console's function configuration page.

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
pnpm turbo zip --filter=@workspace/briefing-worker        # dist/ -> lambda.zip
pnpm --filter=@workspace/briefing-worker invoke           # run the handler locally
```

Running locally needs `OPENAI_API_KEY` and `DATABASE_URL` in the environment and
**nothing else** — no emulator, no AWS credentials, no local host:

```bash
export OPENAI_API_KEY=...
export DATABASE_URL=...            # the pooled endpoint
pnpm turbo build --filter=@workspace/briefing-worker
pnpm --filter=@workspace/briefing-worker invoke
```

That works because `loadSecret()` short-circuits when the target variable is
already set, so the Secrets Manager call never happens. It is also the escape
hatch if Secrets Manager is unreachable but the values are known.

Every invocation prints one JSON `tick` line — `due`, `claimed`, `skipped`,
`succeeded`, `failed` — and one `proof-run` line per job that was actually
claimed. A tick with `"due":0` is a success and exits 0. Any failed job makes
the process exit non-zero, which is what produces the `Errors` datapoint the
alarm watches.

## Forcing a run in AWS

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

Read the result in CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /"event":"tick"/ or @message like /"event":"proof-run"/
| sort @timestamp desc
| limit 40
```

A healthy hour with nothing scheduled is one `tick` line with `"due":0` and no
`proof-run` line at all — which is why the tick line exists. When a job does
run, good looks like `"outcome":"success"` with `"llmCalls":2`. Two calls is the
number that matters: it means model → tool → model, rather than the model
answering from memory without touching the tool.

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

**Nothing catches the throw.** `runScheduledTask()` emits its one-line report
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
