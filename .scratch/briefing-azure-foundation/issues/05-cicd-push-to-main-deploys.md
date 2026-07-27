# 05 — CI/CD: a push to main reaches Azure

**What to build:** A GitHub Actions pipeline, scaffolded by `azd pipeline config`, so that pushing to `main` anything touching the worker, the three agent packages, or the infrastructure deploys to Azure with no manual action — while a dashboard-only push doesn't trigger the pipeline at all. One combined pipeline with `azd up` semantics (no infra/code split), authenticated via OIDC federated credentials with no stored service-principal secret, plus an unfiltered manual `workflow_dispatch` trigger.

Governing material: handoff spec step 7; wayfinder ticket 08 carries the pipeline shape, the path-filter list, and the OIDC decision.

**Blocked by:** 04 — Deploy and verify the scheduled run.

**Status:** ready-for-agent

- [ ] Workflow triggers: push to `main` scoped by paths (worker app, the three agent packages, infra, `azure.yaml`) plus unfiltered `workflow_dispatch`
- [ ] Auth is OIDC federated credentials — no long-lived secret stored in GitHub
- [ ] The build step runs `pnpm turbo build --filter=@workspace/briefing-worker` so `^build` ordering builds the agent packages first
- [ ] A push touching the worker or infra deploys to Azure end to end with no manual action
- [ ] A dashboard-only push does not start the workflow
