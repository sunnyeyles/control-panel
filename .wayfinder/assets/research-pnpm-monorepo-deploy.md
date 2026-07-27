# Research: deploying one app from a pnpm + Turborepo workspace to Azure

Findings for ticket `02-research-pnpm-monorepo-deploy`. Current as of 2026-07. This is a
fact base for the packaging decision, not the decision itself.

## What this repo actually is (grounding)

- pnpm **10.33.4** (`packageManager` in root `package.json`), workspaces `apps/*` + `packages/*`.
- Every internal dependency uses the **`workspace:*` protocol** (e.g. `apps/dashboard` →
  `@workspace/agents`, `@workspace/ui`).
- `.npmrc` pins **`symlink=true`** and that line is load-bearing (the machine's global
  config is `symlink=false`). Any packaging story that flattens or re-links `node_modules`
  has to account for pnpm's symlink layout.
- Two consumption modes for workspace deps:
  - `@workspace/ui` is consumed **as source** via `transpilePackages` — it disappears into
    the Next.js build, no packaging concern.
  - `@workspace/agents` → `@workspace/agents-core` / `@workspace/agent-tools` are consumed
    **as built `dist/`** (`files: ["dist"]`, exports map at `dist/*.js`). Turbo's
    `build.dependsOn: ["^build"]` orders them; any deploy artifact must contain their
    `dist/` output and resolve `workspace:*` to something real.
- The app is **Next.js 16** (`@workspace/dashboard`, dir `apps/dashboard`, turbo name `web`);
  `next.config.ts` currently has **no `output: "standalone"`** and no `outputFileTracingRoot`.
- Native/postinstall deps exist: `pnpm-workspace.yaml` `allowBuilds` whitelists **`sharp`**
  and `unrs-resolver` — so "bundle everything into one JS file" is not automatically clean.

---

## Approach 1: `pnpm deploy --filter=<app>`

What it does: produces a **portable, self-contained directory** — the filtered project's
files plus an isolated real-file `node_modules` with all workspace deps' actual files
copied in (no symlinks out of the directory), executable on a server with no further
install. Docs: <https://pnpm.io/cli/deploy>.

Key mechanics and caveats (pnpm 10):

- **Requires `inject-workspace-packages: true`** by default. Without it, the command
  refuses to run unless you pass **`--legacy`** or set **`force-legacy-deploy=true`**
  (available since pnpm v10.2.1). Discussion:
  <https://github.com/orgs/pnpm/discussions/9015>.
- `inject-workspace-packages=true` changes _daily development_, not just deploys: injected
  workspace deps are **hard-linked copies**, not symlinks, so after building a dependency
  you effectively need a re-install/re-inject for consumers to see fresh `dist/` output —
  reported as a real annoyance in build-graph workflows, plus catalog-protocol errors in
  some setups (same discussion). For this repo — where `symlink=true` is deliberately
  pinned and `tsc --build --watch` dev flows rely on live symlinks — turning it on
  repo-wide is a meaningful cost; `--legacy` / `force-legacy-deploy` avoids that.
- Modern (non-legacy) deploy creates a **dedicated lockfile derived from the shared
  lockfile**, so the output is reproducible and standalone; legacy mode predates that.
- **`--prod`** excludes devDependencies — wanted here, since the built `dist/` needs no
  TypeScript at runtime.
- File selection honors the **`files` field first**, then `.npmignore`/`.gitignore`. The
  agent packages already declare `files: ["dist"]`, which is exactly right — but it means
  **you must run `turbo build` before `pnpm deploy`**, or the copied packages are empty.
- Known sharp edge: `pnpm deploy` + `node-linker=hoisted` historically produced an empty
  `node_modules` (<https://github.com/pnpm/pnpm/issues/6682>) — don't combine them.
- Output still uses pnpm's symlinked virtual-store layout _inside_ the deploy dir (a
  localized virtual store is always created there, even under `enableGlobalVirtualStore`).
  Fine in a container or on a VM; a problem for zip targets that mangle symlinks (see
  Azure gotchas below).

Fit for this repo: strong for a **container image** of a Node service (e.g. an agents
backend). For zip-deploy targets, the internal symlinks are the risk. Invocation shape:
`pnpm --filter=@workspace/dashboard --prod deploy --legacy <out-dir>` (or enable
`inject-workspace-packages` and drop `--legacy`).

## Approach 2: `turbo prune` + multi-stage Dockerfile

What it does: `turbo prune <pkg> --docker` writes an `out/` partial monorepo — `json/`
(only the `package.json`s), `full/` (sources of the target and its internal deps), and a
**pruned `pnpm-lock.yaml`**. Docs: <https://turborepo.dev/docs/reference/prune>.

- Unlike `pnpm deploy`, the output is **still a workspace** — you run `pnpm install` and
  `turbo build` inside it. It solves "copy only what this app needs into the Docker
  context and cache layers well", not "make one self-contained folder".
- Canonical Dockerfile shape: stage 1 `turbo prune web --docker`; stage 2 copy `json/` +
  pruned lockfile, `pnpm install --frozen-lockfile`; stage 3 copy `full/`, `turbo build
--filter=web`; stage 4 runtime image copying only build output. Layer caching means
  dependency install only re-runs when a `package.json`/lockfile changes. Worked examples:
  <https://fintlabs.medium.com/optimized-multi-stage-docker-builds-with-turborepo-and-pnpm-for-nodejs-microservices-in-a-monorepo-c686fdcf051f>,
  <https://github.com/vercel/turborepo/issues/10607> (tsc-built, no-bundler variant —
  exactly this repo's agent packages).
- Caveats: files in `globalDependencies` are **not copied** unless the
  `pruneIncludesGlobalFiles` future flag is on; `--use-gitignore` (default on) can drop
  needed untracked files; `--docker` prune uses the **package name** (`web` today —
  note this repo's name/dir mismatch, and the app manifest now says `@workspace/dashboard`
  while CLAUDE.md says turbo keys off `web`; verify which name is live before pruning).
- Because everything is rebuilt inside the image from the pruned lockfile, `workspace:*`
  resolves normally and pnpm's symlinks are a non-issue — **the container ships whatever
  the final stage copies**, typically a Next.js standalone folder or `dist/` + a
  production `node_modules` (which can itself come from `pnpm deploy` in a late stage —
  the two approaches compose).

For the Next.js app specifically, the final stage should use **`output: "standalone"`**
with **`outputFileTracingRoot`** pointed at the monorepo root, else workspace deps are
missing or the standalone `node_modules` contains broken symlinks:
<https://github.com/vercel/next.js/discussions/40482>,
<https://github.com/vercel/next.js/discussions/35437>,
<https://dev.to/kochan/pnpm-nextjs-standalone-docker-5-failures-before-success-part-9-g3o>.
Do **not** run `pnpm install --prod` inside `.next/standalone` (breaks the traced
`node_modules`), and preserve the monorepo-relative path structure when copying
`.next/static` and `public` into the image.

## Approach 3: bundle app + workspace deps with esbuild/tsup

What it does: compile the entry point plus all `@workspace/*` code plus (optionally) all
npm deps into one or a few JS files. No `node_modules`, no symlinks, no pruning — the
artifact is just files, which makes it the **most zip-friendly** option and sidesteps
every `workspace:*` / symlink question at deploy time.

- Well-trodden for **Azure Functions**: bundle per entry point, tree-shaken, tiny
  packages, fast cold starts. <https://blog.beyerleinf.de/azure-functions-esbuild>,
  <https://github.com/beyerleinf/esbuild-azure-functions>,
  <https://github.com/Azure/azure-functions-nodejs-library/issues/256>. Microsoft used
  the same trick to shrink Azure Pipelines tasks:
  <https://devblogs.microsoft.com/devops/shrinking-azure-pipeline-task-extensions-using-esbuild/>.
- Gotchas: **native/addon deps can't be bundled** — mark them `external` and ship them
  separately (this repo whitelists `sharp`; anything externalized drags a `node_modules`
  back into the artifact, eroding the benefit). Packages relying on `__dirname` asset
  loading, dynamic `require`, or `import.meta.url` file reads need care. The LangChain /
  LangGraph stack is large but pure-JS and generally bundles; verify at build time rather
  than assuming.
- **Does not apply to the Next.js app itself** — Next owns its build; the equivalent lever
  there is `output: "standalone"` (Approach 2). Bundling shines for a _separate small
  service_ (e.g. an agents API on Functions) consuming `@workspace/agents`.

## Azure targets: zip vs container

- **Azure Functions (Flex Consumption, current default for Node):** code-package
  deployment — a zip pushed to a blob container (`released-package.zip` via "one deploy"),
  run from that package. <https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan>,
  <https://learn.microsoft.com/en-us/azure/azure-functions/deployment-zip-push>.
  **Symlinks in the package do not survive** run-from-package mounting — a repeatedly
  reported failure mode for pnpm layouts on Functions:
  <https://github.com/Azure/functions-action/discussions/172>,
  <https://medium.com/@a1guy/dockerfile-for-node-js-based-azure-function-in-a-monorepo-e6a6d80874ba>,
  <https://github.com/Azure/azure-dev/issues/3697>. So for Functions: either **bundle**
  (Approach 3) or produce a genuinely flat, symlink-free `node_modules`.
- **App Service zip deploy / run-from-package:** simplest ops, Azure manages runtime;
  same symlink caveat, plus huge `node_modules` zips are slow to deploy and cold-start.
  <https://learn.microsoft.com/en-us/azure/app-service/deploy-run-package>.
- **Container Apps (or App Service for Containers):** dependency install happens at image
  build; pnpm symlinks live happily inside the image; native deps compile in the build
  stage; the artifact is portable and testable locally. Cost: registry + Dockerfile + a
  slightly heavier pipeline. General tradeoff discussion:
  <https://medium.com/@Nayonae/azure-app-service-vs-container-apps-which-one-does-your-service-need-and-why-c46eadab79fa>.

## Cross-cutting gotchas

- **`workspace:*` resolution:** only pnpm understands it. `pnpm deploy` and `pnpm pack`
  rewrite it; `turbo prune` keeps it (and reinstalls inside the pruned workspace); naive
  `npm install` on copied sources fails outright. Never let a deploy path hit `npm`/`yarn`.
- **Symlinks:** pnpm's default layout is symlinks into `.pnpm` (this repo _pins_ that on).
  Zip pipelines, some CI artifact stores, and Azure run-from-package flatten or drop them.
  Containers and `pnpm deploy` output (consumed in-place) are safe.
- **Hoisting:** `node-linker=hoisted` looks like an easy zip fix but has interacted badly
  with `pnpm deploy` (empty `node_modules`, <https://github.com/pnpm/pnpm/issues/6682>)
  and forfeits pnpm's strictness. Prefer bundling or containers over hoisting.
- **Native deps:** `sharp` (whitelisted in `allowBuilds`) must be built/downloaded for the
  target platform (linux-x64/arm64 vs mac). Docker builds get this right by construction;
  zip built on a Mac does not — build the package in a Linux CI runner if zipping.
- **Build ordering:** `dist/` consumption means every packaging path starts with
  `turbo build` (or runs it inside the Docker build). `pnpm deploy` copies only `files:
["dist"]` — deploying before building yields silently empty packages.

## Recommended patterns and when each wins

1. **`turbo prune --docker` + multi-stage Dockerfile → Azure Container Apps** — wins for
   the **Next.js dashboard**, and whenever native deps, pnpm symlinks, or local
   parity matter. Use `output: "standalone"` + `outputFileTracingRoot` in the final stage.
   Most moving parts, most robust; the community-default pattern for exactly this stack.
2. **esbuild/tsup bundle → zip to Azure Functions (Flex)** — wins for a **small
   Node service** (e.g. an agents endpoint) where cold start and pipeline simplicity
   dominate and native deps are absent or externalizable. Cleanest artifact; sidesteps
   every symlink/workspace issue by having no `node_modules` at all.
3. **`pnpm deploy --prod` (with `--legacy` or `force-legacy-deploy`, unless the repo
   opts into `inject-workspace-packages`)** — wins when you want a **self-contained
   folder without writing a bundler config**: VM/App Service-for-containers, or as the
   final stage inside a Dockerfile. Avoid pairing its raw output with zip/run-from-package
   targets because of internal symlinks; avoid flipping `inject-workspace-packages` on
   repo-wide without accepting the dev-workflow cost.

The decision between these (and the target service) is deliberately left to the follow-up
human-in-the-loop ticket.
