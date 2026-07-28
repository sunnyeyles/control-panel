# @workspace/briefing-worker

A scheduled AWS Lambda that runs one agent task per day at 09:00 UTC, invoked by
EventBridge Scheduler.

Today that task is a **proof task**: it asks an agent for the current UTC time
using a single tool, and its only purpose is to prove the deployment foundation
works end to end — secret delivery, outbound HTTPS, the built `dist/` of the
agent packages resolving at runtime, and a full model → tools → model cycle
through the LangGraph graph. The real briefing replaces the body of
`run-scheduled-task.ts` later; nothing else has to move.

## Layout

```
src/index.ts               shallow — the Lambda handler, and the only AWS-aware file
src/run-scheduled-task.ts  deep — owns the task and its success contract
build.mjs                  esbuild bundle + deploy-root assembly
```

The split between the two `src` modules is the point of the design:
`run-scheduled-task.ts` knows nothing about where it runs, so the task is
testable and portable. Everything platform-shaped — the handler signature and
fetching the API key — lives in `index.ts`.

The schedule is **not** in this package. It lives in
`infra/aws/modules/briefing-worker/schedule.tf`, which keeps it reviewable in a
diff rather than drifting invisibly in console configuration.

## Commands

```bash
pnpm turbo build --filter=@workspace/briefing-worker      # bundle to dist/
pnpm turbo typecheck --filter=@workspace/briefing-worker
pnpm turbo zip --filter=@workspace/briefing-worker        # dist/ -> lambda.zip
pnpm --filter=@workspace/briefing-worker invoke           # run the handler locally
```

Running locally needs `OPENAI_API_KEY` in the environment and **nothing else** —
no emulator, no AWS credentials, no local host:

```bash
export OPENAI_API_KEY=...
pnpm turbo build --filter=@workspace/briefing-worker
pnpm --filter=@workspace/briefing-worker invoke
```

That works because `loadSecret()` short-circuits when `OPENAI_API_KEY` is
already set, so the Secrets Manager call never happens. It is also the escape
hatch if Secrets Manager is unreachable but the value is known.

Success prints one JSON `proof-run` line and exits 0; failure prints one with
`"outcome":"failure"` and exits non-zero.

## Forcing a run in AWS

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

Read the result in CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /"event":"proof-run"/
| sort @timestamp desc
| limit 20
```

Good looks like `"outcome":"success"` with `"llmCalls":2`. Two calls is the
number that matters: it means model → tool → model, rather than the model
answering from memory without touching the tool.

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
and rethrows; the handler lets it through. That throw is what marks the
invocation failed, which is what produces the `Errors` datapoint the alarm
watches. Catching it would turn a broken run into a silent one.

**Build before `terraform plan`.** Terraform reads `lambda.zip` with
`filebase64sha256` at plan time, so a plan on a tree that has not been built
fails with a file-not-found that reads like a Terraform bug.
