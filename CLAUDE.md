# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Next.js 16 — read the local docs first

This repo runs Next.js **16.2.6**, which has breaking changes relative to most training data. Before writing or changing any Next.js code, read the relevant guide under `node_modules/next/dist/docs/` (start at `index.md`; app-router material is under `01-app/`). Heed deprecation notices there over remembered conventions. This rule also lives in `AGENTS.md`.

## Commands

All commands run from the repo root; Turborepo fans them out to workspaces.

Scope to one workspace with a Turborepo filter — **use the package name, not the directory name**:

```bash
pnpm turbo dev --filter=@workspace/dashboard   # apps/dashboard
pnpm turbo typecheck --filter=@workspace/ui
```

The scheduled worker has its own build and run story — an esbuild bundle and
Terraform for deployment. See `apps/briefing-worker/README.md` and
`infra/aws/DEPLOYING.md`; neither the Next.js commands above nor `pnpm dev`
cover it.

Database migrations are outside Turborepo, and **CI applies them** —
`.github/workflows/migrate.yml`, on every push to `main`. The same workflow
applies a PR's migrations to that PR's Neon preview branch, and fails a PR when
production is behind what is already merged. Running one by hand is the escape
hatch, not the routine:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

That runs Prisma Migrate (`prisma migrate deploy`) against the direct Neon
endpoint. **`DATABASE_URL_UNPOOLED`, not `DATABASE_URL`** — the pooled endpoint
runs PgBouncer in transaction mode, which is the wrong endpoint for migrate.
Migrations are forward-only. See `packages/db/README.md`.

**`turbo test` cannot catch an unapplied migration, by construction.**
`stores.test.ts` replays every migration into a throwaway schema, so it proves
the SQL is valid and ordered and knows nothing about any long-lived database.
Drift belongs to the environment, not to the migration set, and the Vercel build
never opens a connection — so a missing table stays invisible until a request
renders the page that reads it. That is what `migrate.yml` is for.

Authentication is Neon Auth (Managed Better Auth), configured from the Neon CLI
rather than from anything in this repo. The workspace is linked to a project and
branch via a git-ignored `.neon`; `neon link` and `neon checkout` write it and
pull that branch's variables into `.env.local`.

```bash
neon neon-auth status                      # is auth on, and at which base URL
neon neon-auth config email-password get   # must stay `Enabled: false`
neon neon-auth oauth-provider list
neon neon-auth domain list                 # trusted redirect targets
neon env pull                              # re-pull after switching branch
```

**`NEON_AUTH_BASE_URL` is per branch.** Every Neon branch gets its own auth
endpoint, its own users and its own JWKS, so a preview branch is a different
auth environment — not a different view of the same one. Never hand-write the
value; re-pull it.

**`NEON_AUTH_COOKIE_SECRET` is ours, not Neon's**, so `env pull` does not
supply it. Generate with `openssl rand -base64 32`; the SDK requires 32+
characters.

**Signup is closed, and `AUTH_ALLOWED_EMAILS` is what closes it.** Neon Auth
creates an account for anyone who completes an OAuth flow; the allowlist check
in `apps/dashboard/lib/auth/current-user.ts` is the only thing standing between
that account and the app. An unset list refuses everyone, deliberately.

Infrastructure is Terraform under `infra/aws/`, and **Turborepo does not cover
it**. One root holds three stacks — the worker, user storage, and the Vercel
dashboard's access to that storage — sharing a single state file, plus
`bootstrap/` for the state bucket and the CI deploy role. Terraform runs
directly:

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

**Only eight workspaces have tests** — `@workspace/dashboard`,
`@workspace/user-storage`, `@workspace/db`, `@workspace/agent-tools`,
`@workspace/agents-core`, `@workspace/agents`, `@workspace/briefing-worker` and
`@workspace/ui`. Vitest is a devDependency of those alone; `turbo test` is a
no-op in the other three. Do not assume a package is covered because the command
exits 0. Adding tests to another workspace means adding `vitest` to it and a
`test` script — the `test` task in `turbo.json` is already there.

In the six that emit `dist/` the same arrangement repeats and is deliberate:
`src/**/*.test.ts` is excluded from `tsconfig.json` so tests never reach
`dist/`, and a `tsconfig.test.json` covers them with `noEmit` because Vitest
transpiles without typechecking. `typecheck` runs both. The dashboard and
`@workspace/ui` need neither half — both are `noEmit` already.

**Evals are a separate task, and `pnpm test` never runs one.** A test asserts
and fails; an eval calls a real model, scores the result between 0 and 1, and is
read as a delta against a committed baseline. Only `@workspace/agents` has one
today, covering the whiteboard agent:

```bash
pnpm turbo run eval --filter=@workspace/agents     # needs OPENAI_API_KEY
```

The task is `cache: false` — `OPENAI_API_KEY` is in `globalEnv`, so a cached hit
would skip the run and print yesterday's scores as today's. It is not in CI on
push or on an ordinary pull request, because a stochastic check behind a
required gate is one people learn to re-run past; `.github/workflows/evals.yml`
runs on `workflow_dispatch` or the `run-evals` label, and needs an
`OPENAI_API_KEY` repository secret that does not exist yet.

**The graders are not part of that and do run in `pnpm test`.** They are pure
functions under `packages/agents/evals/graders/`, and they are the measuring
instrument: one that reported "no overlap" while two boxes were stacked would
make every number downstream a lie. That is why `packages/agents` is the one
workspace whose vitest `include` reaches outside `src/`, and why `evals` is named
in its `tsconfig.test.json`. See `packages/agents/evals/README.md`.

**`@workspace/ui` is tested only under `src/lib/`, and that boundary is the
point.** Everything under `src/components/` is React over a DOM, which would
mean a browser environment and — for the editor — ProseMirror. What is covered
is string-to-string logic deliberately moved out of a component so it could be
reached without any of that: `src/lib/markdown.ts` pins the markdown dialect the
rich-text editor round-trips through, because on Turndown's defaults an
_untouched_ save rewrote every bullet, emphasis and rule in the document. That
is a data-fidelity property, not a rendering one, so it belongs in a test rather
than in a comment.

**`@workspace/db` generates its Prisma Client through a `generate` Turborepo
task**, which `build`, `typecheck`, `test` and `dev` all depend on. They used to
each run `prisma generate` themselves, and racing generates into one directory is
what made `turbo test --force` fail intermittently. Consequence: run its tests
through Turborepo, not `pnpm --filter @workspace/db test` — see
`packages/db/README.md`.

`@workspace/db` splits its suite by whether the thing under test needs Postgres
to _be_ Postgres. `schedule.test.ts` needs nothing. `stores.test.ts` needs a real
database and **skips itself when `DATABASE_URL_UNPOOLED` is unset**, so a clean
`pnpm test` locally does not mean the claim race, the CHECK constraints, or the
partial unique index were exercised — only CI, with a database, exercises those.

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

`docs/agent-architecture.md` draws all of this — the layering above, the compiled graph inside `createAgent`, which agent carries which tools and why that is containment rather than tuning, the three entry points, and how a run is traced.

**Tracing is a fourth package, deliberately outside that stack.** `@workspace/langfuse` owns the Langfuse OpenTelemetry adapter — `initializeLangfuse`, `createLangfuseCallback`, `runWithLangfuseTrace`, `shutdownLangfuse` — and the entry points are what import it: `apps/dashboard/instrumentation-node.ts` and `apps/briefing-worker/src/index.ts`. Nothing the agent stack _ships_ depends on it — `@workspace/agents` devDepends on it for its eval CLI, which is an entry point too — and it depends on nothing in the agent stack, so `@langfuse/*` and `@opentelemetry/*` stay out of the runtime and a consumer that wants untraced agents simply never calls it. Its only tie to LangChain is the `CallbackHandler` type from `@langfuse/langchain`, which every caller passes through `config.callbacks`. Missing keys make all four functions no-ops rather than errors — see `packages/langfuse/README.md`.

**Two packages carry their own `CLAUDE.md`, and it loads only when you work under them** — `apps/dashboard/CLAUDE.md` (the auth gate, Server Action shape, app shell) and `packages/user-storage/CLAUDE.md` (the AWS SDK boundary, key shape, retention tags). Read the relevant one before changing either.

**Tailwind v4, single stylesheet, owned by the UI package.** There is no `tailwind.config.*` anywhere — v4 configures itself from CSS. The one source of truth is `packages/ui/src/styles/globals.css`; the app imports it as `@workspace/ui/globals.css` in `app/layout.tsx`. The app's `postcss.config.mjs` is a one-line re-export of the UI package's. Theme tokens, base colors, and animations belong in that stylesheet, not in the app.

**shadcn/ui components land in the UI package, not the app.** Both `components.json` files use the `radix-nova` style with `baseColor: neutral` and CSS variables. Run the CLI against the app and it writes through to `packages/ui`:

```bash
pnpm dlx shadcn@latest add <component> -c apps/dashboard
```

App-local aliases (`@/components`, `@/hooks`, `@/lib`) exist for app-specific code; the `ui` and `utils` aliases point into `@workspace/ui`.

**Theming is class-based via `next-themes`.** `apps/dashboard/components/theme-provider.tsx` wraps the app with `attribute="class"`, `defaultTheme="system"`, and registers a global `d` hotkey that toggles dark mode (suppressed while focus is in an input, textarea, select, or contenteditable). `<html>` carries `suppressHydrationWarning` because of it.

## Conventions

**Prettier owns formatting** (`.prettierrc`). Match this style when editing — some checked-in files predate it and are not formatted.

**`.npmrc` pins `symlink=true`, and that line is load-bearing.** pnpm can be configured globally with `symlink=false` (this machine is), which downloads packages into `node_modules/.pnpm` but creates no `node_modules` links — so every `workspace:*` dependency becomes unresolvable by both Node and `tsc`, and `pnpm install` still exits 0. The repo-level setting overrides that. If a workspace import suddenly reports `Cannot find module '@workspace/…'`, check this before anything else. It is deliberately the only line in the file: the linker mode itself is left to whatever the machine prefers.

**ESLint never fails.** `eslint-plugin-only-warn` is in the base config, so every rule downgrades to a warning and `pnpm lint` exits 0 regardless. Read the warnings; do not treat a clean exit code as a clean lint.

**TypeScript is strict, including `noUncheckedIndexedAccess`** (`packages/typescript-config/base.json`). Indexed reads are `T | undefined` — narrow them. The base config is `NodeNext`; the Next.js preset overrides to `ESNext`/`Bundler` with `noEmit`.

**In the packages that emit `dist/`, relative imports carry a `.ts` extension and the compiler rewrites it.** Write `import { computeNextRunAt } from "./schedule.ts"` — the extension of the file that actually exists. `rewriteRelativeImportExtensions` in the base config turns that into `./schedule.js` on emit, so `dist/` stays valid Node ESM under NodeNext; the emitted JS is unchanged from when sources spelled `.js` by hand. It also implies `allowImportingTsExtensions`, which is why that flag can coexist with emit at all — on its own it requires `noEmit`.

This rule is scoped to the NodeNext workspaces: `db`, `user-storage`, `agents`, `agents-core`, `agent-tools`, `langfuse`, `briefing-worker`. `@workspace/ui` and `apps/dashboard` override to `Bundler` resolution, where nothing is rewritten and relative imports stay extensionless — `packages/ui/src/components/ai-elements/tool.tsx` importing `"./code-block"` is correct, not a straggler.

Two things here look wrong and are not:

- **Declaration output keeps the `.ts` specifier.** `dist/*.d.ts` reads `from "./keys.ts"`. Only TypeScript reads a `.d.ts`, and it resolves that to the sibling `.d.ts` — downstream packages typecheck against it without needing `allowImportingTsExtensions` themselves. Do not "fix" it.
- **The extension is `.ts`, not nothing.** Extensionless imports would mean abandoning NodeNext for `Bundler` resolution. NodeNext is what the emitted `dist/` and its `.d.ts` declare, and every relative specifier in NodeNext ESM must carry an explicit extension — that is the output contract consumers resolve against, whether Node runs a file directly or esbuild bundles it first.

## Pull requests

**Every pull request uses `.github/pull_request_template.md`, and passing `--body` does not excuse it.** GitHub injects the template only when `gh pr create` is given no body at all, so an agent that composes its own body silently bypasses it. Compose the filled body — the same four headings, in the same order — into a file and open the PR with it:

```bash
gh pr create --title "…" --body-file pr-body.md   # a scratch file, not committed
```

The four sections are required on every PR, however small:

- **`## Type`** — one of Feature, Bug fix, Refactor, Docs, Infrastructure, Chore.
- **`## What this does`** — behaviour, not the diff, written for someone who has not read it. For a feature, what a user can now do that they could not before; for a fix, what was broken, what the user saw, and what they see now. "Adds a helper to parse X" describes the diff and is not an answer.
- **`## Why`** — the problem or need behind the change, in a sentence or two.
- **`## Changes`** — the notable edits, one bullet each, with backticked paths.

`## Verification`, `## Noted, not fixed` and `## ⚠️ Before merging` are optional and sit commented out at the foot of the template. They are house style rather than ceremony: verification carries the commands actually run _and_ what they did not cover, and the ⚠️ heading exists because changes here regularly need a step the merger must take out of band — a migration, a Terraform apply, a secret value, a Neon setting.

**The title is a sentence about the behaviour that changed** — imperative, sentence case, no `feat:`/`fix:` prefix, no trailing period. "Propose search criteria from the candidate's resume", "Fix the Illegal invocation that blanked the dashboard home", "Send OAuth back to the branch alias, not the deployment host". A title derived from the branch name — "Worktree dev auth bypass" — is the failure mode this rule exists to stop, and is never acceptable.

**`CONTEXT.md` binds the prose.** A PR body is prose about this system, so the glossary applies to it: "job" is a row in `jobs`, never an employment opportunity — that is a "posting".

Two constraints are not about writing and are set out in `RELEASING.md`: **squash-merge**, because GitGuardian scans every commit on a pull request and a credential-shaped string removed in a later commit still flags; and a pull request runs `check` only, since the deploy role's trust policy names `ref:refs/heads/main` alone.

Close an agent-written body with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` trailer. The template itself does not carry it — a human filling it in from the GitHub UI is not generating anything.

## Repo context

`.mcp.json` registers the LangChain docs and API-reference MCP servers, and `.claude/skills/` symlinks a set of vendored skills (tracked in `skills-lock.json`) into `.agents/skills/`.

**A `SessionEnd` hook deletes worktrees whose pull request is finished.** `.claude/hooks/cleanup-merged-worktrees.sh`, wired up in `.claude/settings.json`, removes a checkout under `.claude/worktrees/` and its local branch once GitHub reports the branch's PR as merged or closed. It refuses to touch a worktree that a live session still holds, that has uncommitted changes, or that carries a commit the remote has never seen — an open PR is left alone entirely, so a review can still be answered from the same checkout. Removals and refusals are logged to `~/.claude/worktree-cleanup.log`; nothing is written and no network call is made when there is nothing to collect.

`CONTEXT.md` is the domain glossary — what "briefing", "brief", "scout", "findings" and "run report" mean, and which words to avoid. Read it before writing prose about this system: **"job" means a row in `jobs`, a thing that runs on a cadence, and never an employment opportunity** — that is a "posting". The schema owns the word and prose must not borrow it back. `OVERVIEW.md` states the shape of the pipeline and, in its "Not built yet" section, what the product still lacks: closing the criteria loop with nobody watching, scout fan-out, _sending_ a cover letter, and a viewer for the brief itself. **Read that section rather than assuming from the heading** — most of its entries are partly closed, so proposing criteria from a resume, and drafting, listing and editing a cover letter, are all built.

**Design material in the tree is either a live plan or a ticket set, and a plan is deleted once its work ships.** `docs/job-kind-registry-plan.md` is the one live plan — a dispatch registry for the worker, with nothing implementing it yet. `.scratch/<feature>/` holds committed ticket sets: an `issues/` directory, sometimes a `plan.md` and a `README.md`. That is where a feature's tickets live, never GitHub Issues, despite the remote having labels for them. Superseded design material belongs in git history rather than in an annotated file — a `.wayfinder/` ticket set and the staged cover-letter plan both went that way.
