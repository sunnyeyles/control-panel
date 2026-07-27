# @workspace/briefing-worker

A scheduled Azure Functions timer that runs one agent task per day at 09:00 UTC.

Today that task is a **proof task**: it asks an agent for the current UTC time
using a single tool, and its only purpose is to prove the deployment foundation
works end to end — secret delivery, outbound HTTPS, the built `dist/` of the
agent packages resolving at runtime, and a full model → tools → model cycle
through the LangGraph graph. The real briefing replaces the body of
`runScheduledTask.ts` later; nothing else has to move.

## Layout

```
src/functions/scheduledRun.ts   shallow — binds a schedule to the task
src/runScheduledTask.ts         deep — owns the task and its success contract
src/index.ts                    entry point; importing a trigger registers it
host.json                       Functions host config (source of truth)
build.mjs                       esbuild bundle + deploy-root assembly
local.settings.json             gitignored; local `func start` settings
```

The split between the two `src` modules is the point of the design: the
schedule and the Functions binding never change when the task changes.

## Commands

```bash
pnpm turbo build --filter=@workspace/briefing-worker      # bundle to dist/
pnpm turbo typecheck --filter=@workspace/briefing-worker
pnpm --filter=@workspace/briefing-worker zip              # dist/ -> functionapp.zip
pnpm --filter=@workspace/briefing-worker start            # func start, local host
```

Running locally needs `OPENAI_API_KEY` in the environment and an Azure Storage
emulator for the timer's checkpointing:

```bash
pnpm dlx azurite --silent --location /tmp/azurite &
export OPENAI_API_KEY=...
pnpm --filter=@workspace/briefing-worker build
pnpm --filter=@workspace/briefing-worker start
```

A timer will not fire on demand, so trigger a run through the admin endpoint:

```bash
curl -X POST http://localhost:7071/admin/functions/scheduledRun \
  -H 'Content-Type: application/json' -d '{"input":""}'
```

Success prints one JSON `proof-run` line and the host logs `Succeeded`; failure
prints one with `"outcome":"failure"` and the host logs `Failed`.

## Things that are load-bearing and look like they are not

**`packageManager` in `package.json`.** azd detects the package manager from
this field. Without it azd restores the service with `npm install`, which fails
outright on this repo's `workspace:*` dependencies
(`npm error EUNSUPPORTEDPROTOCOL`). It is a deployment dependency, not a note
about local tooling.

**`dist/` is a deploy root, not compiler output.** `build.mjs` copies
`host.json` in and generates a second, minimal `package.json` there, because
the Functions v4 programming model locates the module that registers functions
through `main`. `azure.yaml` points azd's `dist` at this folder, so the uploaded
zip is exactly these files — and in particular never `node_modules`, whose pnpm
symlinks do not survive run-from-package mounting.

**`local.settings.json` is deliberately not copied into `dist/`.** Keeping it
out is what stops local settings from reaching a deploy artifact.

**`@azure/functions-core` is the one esbuild external.** It is not an npm
package; the Functions host injects it at runtime, so it cannot be bundled.

**App Insights sampling is off in `host.json`.** The starter enables it. The
verification for this service is a single trace line per run, and a sampled-out
line reads as "the run never started" — the exact false signal that check
exists to catch. At one run per day there is nothing to sample anyway.
