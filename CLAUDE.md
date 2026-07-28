# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Next.js 16 — read the local docs first

This repo runs Next.js **16.2.6**, which has breaking changes relative to most training data. Before writing or changing any Next.js code, read the relevant guide under `node_modules/next/dist/docs/` (start at `index.md`; app-router material is under `01-app/`). Heed deprecation notices there over remembered conventions. This rule also lives in `AGENTS.md`.

## Commands

All commands run from the repo root; Turborepo fans them out to workspaces.

```bash
pnpm dev         # next dev for apps/dashboard (persistent, uncached)
pnpm build       # turbo build
pnpm lint        # eslint per workspace
pnpm typecheck   # tsc --noEmit per workspace
pnpm format      # prettier --write per workspace (writes, does not check)
```

Scope to one workspace with a Turborepo filter — **use the package name, not the directory name**:

```bash
pnpm turbo dev --filter=@workspace/dashboard   # apps/dashboard
pnpm turbo typecheck --filter=@workspace/ui
```

The scheduled worker has its own build and run story — an esbuild bundle and
Terraform for deployment. See `apps/briefing-worker/README.md` and
`infra/aws/DEPLOYING.md`; neither the Next.js commands above nor `pnpm dev`
cover it.

Database migrations are also outside Turborepo, and are run by hand:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

**`DATABASE_URL_UNPOOLED`, not `DATABASE_URL`** — the runner takes a
session-level advisory lock, and the pooled endpoint runs PgBouncer in
transaction mode, which does not carry one across statements. Through the
pooler the lock appears to be taken while holding nothing. Migrations are
forward-only; there are no down migrations. See `packages/db/README.md`.

The runner executes TypeScript source through `tsx`, so it needs no prior
build and can never apply a stale `dist/`.

Infrastructure is Terraform under `infra/aws/`, and **Turborepo does not cover
it**. One root holds two stacks — the worker and user storage — sharing a single
state file, plus `bootstrap/` for the state bucket and the CI deploy role.
Terraform runs directly:

```bash
terraform -chdir=infra/aws fmt -recursive -check
terraform -chdir=infra/aws init -backend=false && terraform -chdir=infra/aws validate
terraform -chdir=infra/aws test
```

`test` is the real check and needs no credentials: the suite under
`infra/aws/tests/` runs a mocked plan and asserts on what it produces. Run
`init` first — it installs the modules the run blocks target.

`plan` is where credentials start being needed: it calls STS while configuring
the provider and fails before reaching a resource. It also reads `lambda.zip` at
plan time, so build before planning.

Stack configuration lives in the committed `infra/aws/terraform.tfvars`, so
`apply` takes no `-var` flags. Adding a stack means adding a
`<stack>.{tf,variables.tf,outputs.tf}` triple and one line there — see
`infra/aws/README.md`.

Tests are their own task, and a thin one:

```bash
pnpm test        # turbo test
```

**Only `@workspace/user-storage` and `@workspace/db` have tests.** Vitest is the
runner and is a devDependency of those two alone; `turbo test` is a no-op in the
other six workspaces. Do not assume a package is covered because the command
exits 0. Adding tests to another workspace means adding `vitest` to it and a
`test` script — the `test` task in `turbo.json` is already there.

`@workspace/db` splits its suite by whether the thing under test needs Postgres
to _be_ Postgres. `schedule.test.ts` needs nothing. `stores.test.ts` needs a real
database and **skips itself when `DATABASE_URL_UNPOOLED` is unset**, so a clean
`pnpm test` locally does not mean the claim race, the CHECK constraints, or the
partial unique index were exercised — only CI, with a database, exercises those.

## Layout

| Path                         | Package name                   | Role                                                                |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `apps/dashboard`             | `@workspace/dashboard`         | Next.js 16 App Router, React 19.2.                                  |
| `apps/briefing-worker`       | `@workspace/briefing-worker`   | AWS Lambda, hourly tick. Bundled by esbuild, deployed by Terraform. |
| `packages/agents`            | `@workspace/agents`            | Named agents — a prompt plus a tool set. One per module.            |
| `packages/agent-tools`       | `@workspace/agent-tools`       | The shared tool catalog. One tool per module.                       |
| `packages/agents-core`       | `@workspace/agents-core`       | LangGraph runtime: graph, state, model, tool registry.              |
| `packages/db`                | `@workspace/db`                | Postgres: jobs, runs, artifacts. The only place SQL lives.          |
| `packages/user-storage`      | `@workspace/user-storage`      | S3 storage for per-user data, behind an interface.                  |
| `packages/ui`                | `@workspace/ui`                | Shared components, the Tailwind stylesheet, and `cn()`.             |
| `packages/eslint-config`     | `@workspace/eslint-config`     | Flat configs: `base`, `next-js`, `react-internal`.                  |
| `packages/typescript-config` | `@workspace/typescript-config` | `base.json`, `nextjs.json`, `react-library.json`.                   |

## Architecture

**The UI package is consumed as source, not as a build artifact.** `@workspace/ui` has no build step. Its `exports` map subpaths straight at TypeScript sources (`./components/*` → `./src/components/*.tsx`, `./lib/*` → `./src/lib/*.ts`), and the app compiles them via `transpilePackages: ["@workspace/ui"]` in `next.config.ts`. Consequences:

- Import as `@workspace/ui/components/button`, `@workspace/ui/lib/utils` — one file per subpath, no barrel index.
- Adding a component means adding a file under `packages/ui/src/components/`; no export list to update.
- The app's `tsconfig.json` also path-maps `@workspace/ui/*` → `../../packages/ui/src/*` so the editor resolves it without a build.

**The agent stack is three layers, and the direction of the arrows is the point.** Unlike `@workspace/ui`, these are consumed as built output (`dist/`), so Turbo's `build.dependsOn: ["^build"]` orders them ahead of anything importing them — and `typecheck.dependsOn` is `["^build"]` for the same reason, since a consumer typechecks against its dependencies' emitted `.d.ts`.

```
@workspace/agents        prompt + tool set per named agent
        ↓
@workspace/agents-core   graph, state, model factory, tool registry
@workspace/agent-tools   the tool catalog (does NOT depend on the runtime)
```

- **`agents-core` ships no tools and no agents.** It is the runtime only, and `createAgent({ tools })` defaults to none. Keeping concrete tools out of it means a project can take the runtime and supply its own.
- **`agent-tools` does not depend on `agents-core`.** Tools are plain LangChain tools (`StructuredToolInterface`), so they work with any caller. `AgentTool` in the runtime is a type alias for that same interface — the two line up structurally, not by dependency.
- **Both new packages use wildcard subpath exports** (`./*` → `./dist/*.js`). Adding `src/weather.ts` makes `@workspace/agent-tools/weather` importable with no config change — same spirit as the UI package's one-file-per-subpath rule, no barrel to update.
- **Agents are exported as `createX()` factories, never as instances.** Building one constructs a model, which reads `OPENAI_API_KEY` and throws without it; a module-level instance would move that failure to import time and break any consumer that merely imports the module.
- **Prefer per-tool imports over `allTools`.** A model picks worse as the tool list grows, so give an agent the tools its job needs.

**`@workspace/user-storage` hides the AWS SDK behind one module.** `s3-user-object-store.ts` is the only file in the repo that imports `@aws-sdk/client-s3`. Everything else depends on the `UserObjectStore` interface — or, better, on the narrow `BriefStore` / `ResumeStore` facades over it, which know their kind's key shape and file types so a call site cannot get them wrong. Call `createS3UserObjectStore()` only at a composition root: same `createX()` factory rule as the agents, and for the same reason — constructing one reads configuration, so a module-level instance would move that failure to import time.

Three things about that package are load-bearing and easy to undo by accident:

- **Object keys are `{environment}/{userId}/{kind}/…tail.{ext}`, and `userId` sits above `kind` deliberately** — erasing a user is then one prefix, not one per kind. The segment validation in `keys.ts` is the ownership boundary, not a tidiness rule: an unvalidated `userId` of `../someone-else` addresses another user's prefix.
- **Retention is driven by an object _tag_, not a key prefix.** S3 lifecycle filters take no wildcards, so with `userId` in the middle there is no prefix meaning "every user's briefs". Every object is tagged `kind=<kind>` at write time and the Terraform lifecycle rules filter on that — which is why the IAM policies must grant `s3:PutObjectTagging`, and why a kind added to `kinds.ts` without a matching `object_kinds` entry in Terraform silently gets no retention at all.
- **Content types are derived from the extension, never accepted from the caller,** against a per-kind allowlist in `kinds.ts`. A caller-supplied media type would let a `.pdf` be stored as `text/html`. Uploaded kinds are also stored `Content-Disposition: attachment`.

**Tailwind v4, single stylesheet, owned by the UI package.** There is no `tailwind.config.*` anywhere — v4 configures itself from CSS. The one source of truth is `packages/ui/src/styles/globals.css`; the app imports it as `@workspace/ui/globals.css` in `app/layout.tsx`. The app's `postcss.config.mjs` is a one-line re-export of the UI package's. Theme tokens, base colors, and animations belong in that stylesheet, not in the app.

**shadcn/ui components land in the UI package, not the app.** Both `components.json` files use the `radix-nova` style with `baseColor: neutral` and CSS variables. Run the CLI against the app and it writes through to `packages/ui`:

```bash
pnpm dlx shadcn@latest add <component> -c apps/dashboard
```

App-local aliases (`@/components`, `@/hooks`, `@/lib`) exist for app-specific code; the `ui` and `utils` aliases point into `@workspace/ui`.

**Theming is class-based via `next-themes`.** `apps/dashboard/components/theme-provider.tsx` wraps the app with `attribute="class"`, `defaultTheme="system"`, and registers a global `d` hotkey that toggles dark mode (suppressed while focus is in an input, textarea, select, or contenteditable). `<html>` carries `suppressHydrationWarning` because of it.

## Conventions

**Prettier owns formatting** (`.prettierrc`): no semicolons, double quotes, 2-space tabs, 80-column width, ES5 trailing commas, LF. `prettier-plugin-tailwindcss` sorts classes and is pointed at `packages/ui/src/styles/globals.css` via `tailwindStylesheet`; it also sorts inside `cn()` and `cva()` calls. Match this style when editing — some checked-in files predate it and are not formatted.

**`.npmrc` pins `symlink=true`, and that line is load-bearing.** pnpm can be configured globally with `symlink=false` (this machine is), which downloads packages into `node_modules/.pnpm` but creates no `node_modules` links — so every `workspace:*` dependency becomes unresolvable by both Node and `tsc`, and `pnpm install` still exits 0. The repo-level setting overrides that. If a workspace import suddenly reports `Cannot find module '@workspace/…'`, check this before anything else. It is deliberately the only line in the file: the linker mode itself is left to whatever the machine prefers.

**ESLint never fails.** `eslint-plugin-only-warn` is in the base config, so every rule downgrades to a warning and `pnpm lint` exits 0 regardless. Read the warnings; do not treat a clean exit code as a clean lint.

**TypeScript is strict, including `noUncheckedIndexedAccess`** (`packages/typescript-config/base.json`). Indexed reads are `T | undefined` — narrow them. The base config is `NodeNext`; the Next.js preset overrides to `ESNext`/`Bundler` with `noEmit`.

**Relative imports carry a `.ts` extension, and the compiler rewrites it.** Write `import { computeNextRunAt } from "./schedule.ts"` — the extension of the file that actually exists. `rewriteRelativeImportExtensions` in the base config turns that into `./schedule.js` on emit, so `dist/` stays valid Node ESM under NodeNext; the emitted JS is unchanged from when sources spelled `.js` by hand. It is also what lets `allowImportingTsExtensions` coexist with emit, which normally requires `noEmit`.

Two things here look wrong and are not:

- **Declaration output keeps the `.ts` specifier.** `dist/*.d.ts` reads `from "./keys.ts"`. Only TypeScript reads a `.d.ts`, and it resolves that to the sibling `.d.ts` — downstream packages typecheck against it without needing `allowImportingTsExtensions` themselves. Do not "fix" it.
- **The extension is `.ts`, not nothing.** Extensionless imports would mean abandoning NodeNext for `Bundler` resolution, which breaks any `dist/` that Node runs directly — the migration CLI, and the worker before esbuild bundles it.

## Repo context

`.mcp.json` registers the LangChain docs and API-reference MCP servers, and `.claude/skills/` symlinks a set of vendored skills (tracked in `skills-lock.json`) into `.agents/skills/`.

`CONTEXT.md` is the domain glossary — what "briefing", "proof run" and "run report" mean, and which words to avoid. `OVERVIEW.md` states the intended shape of the pipeline. Both describe a platform that is mostly still ahead of the code: the working tree today is the scaffold described above plus a deployed worker running a trivial proof task. Earlier commits carried more design material (a `.wayfinder/` ticket set, planning docs) that survives only in git history — historical intent, not current spec.
