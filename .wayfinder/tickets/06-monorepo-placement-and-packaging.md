---
title: "Decide the worker's place in the monorepo and its packaging"
type: grilling
status: open
assignee:
blocked-by:
  - 02-research-pnpm-monorepo-deploy.md
  - 05-choose-compute-service.md
---

## Question

Where does the scheduled worker live in this workspace and how is it built for deploy? Decide: its path and package name (e.g. a new app under `apps/`), consistent with the existing `apps/dashboard`-is-named-`web` caution; how it consumes `@workspace/agents` (built `dist/`, per the existing three-layer rule); its `turbo.json` wiring (`build.dependsOn: ["^build"]`, typecheck against emitted `.d.ts`); and the packaging route the compute choice implies (container image, zip, or single-file bundle) including where the Dockerfile or bundle config lives. Consult the `codebase-design` skill for the seam.
