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

The scheduled worker has its own build and run story — an esbuild bundle, a
local Azure Functions host, and azd for deployment. See
`apps/briefing-worker/README.md` and `infra/README.md`; neither the Next.js
commands above nor `pnpm dev` cover it.

Infrastructure is **two stacks mid-migration**, and Turborepo covers neither.
`infra/` is Bicep behind `azd` for the live Azure deployment (`infra/README.md`);
`infra/aws/` is Terraform for AWS (`infra/aws/README.md`). Terraform commands
run directly:

```bash
terraform -chdir=infra/aws fmt -recursive -check
terraform -chdir=infra/aws init -backend=false && terraform -chdir=infra/aws validate
```

`validate` is the ceiling without AWS credentials — `plan` calls STS while
configuring the provider and fails before reaching a resource.

```bash
pnpm test        # turbo test
```

**Only `@workspace/user-storage` has tests.** Vitest is the runner, and it is a
devDependency of that package alone; `turbo test` is a no-op everywhere else. Do
not assume a package is covered because the command exits 0. Adding tests to
another workspace means adding `vitest` to it and a `test` script — the `test`
task in `turbo.json` is already there.

## Layout

| Path                         | Package name                   | Role                                                        |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `apps/dashboard`             | `@workspace/dashboard`         | Next.js 16 App Router, React 19.2.                          |
| `apps/briefing-worker`       | `@workspace/briefing-worker`   | Azure Functions timer. Bundled by esbuild, deployed by azd. |
| `packages/agents`            | `@workspace/agents`            | Named agents — a prompt plus a tool set. One per module.    |
| `packages/agent-tools`       | `@workspace/agent-tools`       | The shared tool catalog. One tool per module.               |
| `packages/agents-core`       | `@workspace/agents-core`       | LangGraph runtime: graph, state, model, tool registry.      |
| `packages/user-storage`      | `@workspace/user-storage`      | S3 storage for per-user data, behind an interface.          |
| `packages/ui`                | `@workspace/ui`                | Shared components, the Tailwind stylesheet, and `cn()`.     |
| `packages/eslint-config`     | `@workspace/eslint-config`     | Flat configs: `base`, `next-js`, `react-internal`.          |
| `packages/typescript-config` | `@workspace/typescript-config` | `base.json`, `nextjs.json`, `react-library.json`.           |

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

## Repo context

`.mcp.json` registers the LangChain docs and API-reference MCP servers, and `.claude/skills/` symlinks a set of vendored skills (tracked in `skills-lock.json`) into `.agents/skills/`.

Earlier commits carried design documents — `CONTEXT.md` (a domain glossary) and `.wayfinder/` (numbered decision tickets) — for a local, single-user Gmail assistant with a Next.js dashboard and a Python/LangChain agent backend. Those files are deleted in the working tree and survive only in git history (`git show HEAD:CONTEXT.md`). Treat them as historical intent, not current spec; the working tree today is the scaffold described above.
