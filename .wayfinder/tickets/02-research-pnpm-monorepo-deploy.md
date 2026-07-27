---
title: "Research: deploying one app from a pnpm + Turborepo workspace to Azure"
type: research
status: closed
assignee: research-agent
blocked-by: []
---

## Question

What are the current (mid-2026) sound patterns for packaging **one app** out of a pnpm + Turborepo monorepo for deployment to Azure, when the app depends on workspace packages consumed as built `dist/` output? Cover: `pnpm deploy --filter` (pruned, self-contained output and its lockfile/injected-deps caveats), `turbo prune`, multi-stage Dockerfiles for pnpm monorepos, and bundling the app plus workspace deps into a single file with esbuild/tsup so no `node_modules` pruning is needed. Note zip-deploy vs container-image tradeoffs on Azure targets, and gotchas: `workspace:*` protocol resolution, pnpm symlink behavior (this repo pins `symlink=true`), hoisting, and native dependencies. End with the recommended pattern(s) and the conditions under which each wins — a fact base for the packaging decision, not the decision itself.

## Resolution

Researched all four packaging approaches against this repo's actual setup (pnpm 10.33.4, `symlink=true`, `dist/`-consumed agent packages, `sharp` native dep). Headline: `turbo prune --docker` + multi-stage Dockerfile + Next `output: "standalone"` to Container Apps for the dashboard; esbuild/tsup bundling for any small zip-deployed Functions service (pnpm symlinks do not survive Azure run-from-package); `pnpm deploy --prod` (needs `--legacy` or `inject-workspace-packages`, which has dev-workflow costs) for self-contained folders consumed in place. Full fact base with citations: [../assets/research-pnpm-monorepo-deploy.md](../assets/research-pnpm-monorepo-deploy.md). Decision deferred to the follow-up ticket.
