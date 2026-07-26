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
pnpm turbo dev --filter=web            # apps/dashboard
pnpm turbo typecheck --filter=@workspace/ui
```

There is **no test setup** in this repo — no test runner, no `test` task in `turbo.json`, no test script in any package. Do not invent test commands; if tests are needed, the framework has to be chosen and wired up first.

## Layout

| Path                         | Package name                   | Role                                                    |
| ---------------------------- | ------------------------------ | ------------------------------------------------------- |
| `apps/dashboard`             | `web`                          | The only app. Next.js 16 App Router, React 19.2.        |
| `packages/ui`                | `@workspace/ui`                | Shared components, the Tailwind stylesheet, and `cn()`. |
| `packages/eslint-config`     | `@workspace/eslint-config`     | Flat configs: `base`, `next-js`, `react-internal`.      |
| `packages/typescript-config` | `@workspace/typescript-config` | `base.json`, `nextjs.json`, `react-library.json`.       |

**Naming mismatch to watch:** the directory is `apps/dashboard` but `package.json` still declares `"name": "web"`. Turbo filters, `pnpm --filter`, and dependency references all key off `web`. Git also still tracks the old `apps/web` path.

## Architecture

**The UI package is consumed as source, not as a build artifact.** `@workspace/ui` has no build step. Its `exports` map subpaths straight at TypeScript sources (`./components/*` → `./src/components/*.tsx`, `./lib/*` → `./src/lib/*.ts`), and the app compiles them via `transpilePackages: ["@workspace/ui"]` in `next.config.ts`. Consequences:

- Import as `@workspace/ui/components/button`, `@workspace/ui/lib/utils` — one file per subpath, no barrel index.
- Adding a component means adding a file under `packages/ui/src/components/`; no export list to update.
- The app's `tsconfig.json` also path-maps `@workspace/ui/*` → `../../packages/ui/src/*` so the editor resolves it without a build.

**Tailwind v4, single stylesheet, owned by the UI package.** There is no `tailwind.config.*` anywhere — v4 configures itself from CSS. The one source of truth is `packages/ui/src/styles/globals.css`; the app imports it as `@workspace/ui/globals.css` in `app/layout.tsx`. The app's `postcss.config.mjs` is a one-line re-export of the UI package's. Theme tokens, base colors, and animations belong in that stylesheet, not in the app.

**shadcn/ui components land in the UI package, not the app.** Both `components.json` files use the `radix-nova` style with `baseColor: neutral` and CSS variables. Run the CLI against the app and it writes through to `packages/ui`:

```bash
pnpm dlx shadcn@latest add <component> -c apps/dashboard
```

App-local aliases (`@/components`, `@/hooks`, `@/lib`) exist for app-specific code; the `ui` and `utils` aliases point into `@workspace/ui`.

**Theming is class-based via `next-themes`.** `apps/dashboard/components/theme-provider.tsx` wraps the app with `attribute="class"`, `defaultTheme="system"`, and registers a global `d` hotkey that toggles dark mode (suppressed while focus is in an input, textarea, select, or contenteditable). `<html>` carries `suppressHydrationWarning` because of it.

## Conventions

**Prettier owns formatting** (`.prettierrc`): no semicolons, double quotes, 2-space tabs, 80-column width, ES5 trailing commas, LF. `prettier-plugin-tailwindcss` sorts classes and is pointed at `packages/ui/src/styles/globals.css` via `tailwindStylesheet`; it also sorts inside `cn()` and `cva()` calls. Match this style when editing — some checked-in files predate it and are not formatted.

**ESLint never fails.** `eslint-plugin-only-warn` is in the base config, so every rule downgrades to a warning and `pnpm lint` exits 0 regardless. Read the warnings; do not treat a clean exit code as a clean lint.

**TypeScript is strict, including `noUncheckedIndexedAccess`** (`packages/typescript-config/base.json`). Indexed reads are `T | undefined` — narrow them. The base config is `NodeNext`; the Next.js preset overrides to `ESNext`/`Bundler` with `noEmit`.

## Repo context

`.mcp.json` registers the LangChain docs and API-reference MCP servers, and `.claude/skills/` symlinks a set of vendored skills (tracked in `skills-lock.json`) into `.agents/skills/`.

Earlier commits carried design documents — `CONTEXT.md` (a domain glossary) and `.wayfinder/` (numbered decision tickets) — for a local, single-user Gmail assistant with a Next.js dashboard and a Python/LangChain agent backend. Those files are deleted in the working tree and survive only in git history (`git show HEAD:CONTEXT.md`). Treat them as historical intent, not current spec; the working tree today is the scaffold described above.
