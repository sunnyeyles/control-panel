---
title: "Decide the worker's place in the monorepo and its packaging"
type: grilling
status: closed
assignee: claude-bg-d9f8f2ee
blocked-by:
  - 02-research-pnpm-monorepo-deploy.md
  - 05-choose-compute-service.md
---

## Question

Where does the scheduled worker live in this workspace and how is it built for deploy? Decide: its path and package name (e.g. a new app under `apps/`), consistent with the existing `apps/dashboard`-is-named-`web` caution; how it consumes `@workspace/agents` (built `dist/`, per the existing three-layer rule); its `turbo.json` wiring (`build.dependsOn: ["^build"]`, typecheck against emitted `.d.ts`); and the packaging route the compute choice implies (container image, zip, or single-file bundle) including where the Dockerfile or bundle config lives. Consult the `codebase-design` skill for the seam.

## Resolution

**Stale premise check first**: the "`apps/dashboard`-is-named-`web`" caution this ticket quotes from `CLAUDE.md` no longer holds — `apps/dashboard/package.json` now declares `"name": "@workspace/dashboard"`, matching its directory. `CLAUDE.md` itself is out of date on this point (worth a fix, but out of scope here). Consequence: there's no live mismatch convention to stay consistent with, and no reason to repeat it — the new worker's directory name and package name should simply match each other.

**Path and package name**: `apps/briefing-worker`, package name `@workspace/briefing-worker` (scoped, matching the `@workspace/dashboard` precedent, not the historical unscoped `"web"`). "Briefing" over a generic "worker" or "scheduler" name because `CONTEXT.md` already reserves that term for the eventual real workload this app will run — naming it now avoids a rename later. Private, `"type": "module"`, matching every other workspace package.

**Consuming the agent stack**: the proof task (ticket 03) deliberately bypasses `@workspace/agents` — it calls `createAgent` from `@workspace/agents-core` directly with only the `getCurrentTime` tool from `@workspace/agent-tools`. So `apps/briefing-worker`'s initial `dependencies` are `@workspace/agents-core` and `@workspace/agent-tools`, both consumed as built `dist/` per the existing three-layer rule — `@workspace/agents` is _not_ a dependency yet. When the real Briefing's search agents and orchestrator are built later (as new modules in `@workspace/agents`, per that package's own convention), the worker adds `@workspace/agents` as a dependency then and imports the specific `createX()` factories it needs — no restructuring of this app, just a new import and a swapped function body inside the seam below.

**The seam** (per `codebase-design`): the Functions trigger binding and the task logic are two different modules, so the trigger never has to change when the _task_ changes.

```
apps/briefing-worker/
  src/
    functions/
      scheduledRun.ts   # app.timer(...) registration only: schedule string, calls runScheduledTask()
    runScheduledTask.ts  # today: proof task (createAgent + getCurrentTime). Later: the Briefing task.
    index.ts              # imports ./functions/scheduledRun for its registration side-effect
  host.json
  local.settings.json     # gitignored; local-only OPENAI_API_KEY for `func start`
  package.json
  build.mjs               # esbuild invocation (see Packaging)
```

`runScheduledTask.ts` is the deep module — it owns the entire "what does a run do and what counts as success" contract from ticket 03 (build the agent, invoke it, shape and emit the JSON run-report line, throw on failure). `scheduledRun.ts` is intentionally shallow: it only wires a schedule string to that function via the Azure Functions v4 `app.timer()` programming model. Swapping the proof task for the real Briefing later means replacing the body of `runScheduledTask.ts` (and adding real tools/agents) without touching the trigger registration.

**`turbo.json` wiring**: no changes needed. The root `build` task already has `dependsOn: ["^build"]` and an `outputs` glob that includes `dist/**`, which already covers this app's bundle output; `typecheck` already `dependsOn: ["^build"]`, so it type-checks against `@workspace/agents-core`'s and `@workspace/agent-tools`'s emitted `.d.ts` exactly like every other consumer. `apps/briefing-worker/package.json` gets its own `build`/`typecheck`/`lint`/`format` scripts following the same shape as `apps/dashboard`'s.

**Packaging**: per ticket 05 (Flex Consumption, zip deploy) and ticket 02's research (pnpm symlinks don't survive Azure run-from-package), the worker is bundled with **esbuild, invoked directly** via a small `apps/briefing-worker/build.mjs` script calling esbuild's API — put to the human in the grilling exchange, who chose it over tsup for explicit control of the Functions v4 output layout and externals, with no wrapper abstraction between the config and the output (an earlier concurrent draft of this resolution said tsup; this amendment records the human's actual decision). Entry `src/index.ts`, target `node22` (see version note below), format `esm` (Functions v4 Node model supports ESM), `bundle: true`, output to `apps/briefing-worker/dist/index.js`; the app's `build` script runs `node build.mjs`. `@azure/functions` has no native dependencies, so it's bundled in too rather than left external — keeping the artifact to one file plus `host.json`. A `zip` script (`package.json` → `"zip": "cd dist && zip -r ../functionapp.zip . && cd .. && zip -j functionapp.zip host.json"`, or equivalent) produces the deploy artifact ticket 08's pipeline pushes; no Dockerfile exists anywhere in this app, correctly, since Flex Consumption zip-deploy needs none.

**Node version**: **Node 22** — the current Active LTS as of this decision and supported on Flex Consumption; pin it in `apps/briefing-worker/package.json` `engines.node` and in the Bicep function app's `functionAppConfig.runtime.version` (ticket 07's concern). Confirm against `az functionapp list-flexconsumption-runtimes` at implementation time in case regional availability lags.
