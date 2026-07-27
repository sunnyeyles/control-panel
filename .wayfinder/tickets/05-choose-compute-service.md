---
title: "Choose the compute service for the scheduled job"
type: grilling
status: closed
assignee: claude-fg-38d95118
blocked-by:
  - 01-research-scheduled-compute-options.md
  - 02-research-pnpm-monorepo-deploy.md
  - 03-define-proof-task-and-success.md
---

## Question

Which Azure service runs the scheduled briefing job? Decide from the research fact base plus the proof-task definition: the winner must satisfy the cadence, runtime, packaging (which the pnpm-deployment research constrains), secrets, and cost facts surfaced. Record the choice **and** how a scheduled run's logs land and a failed run surfaces on that service — observability is part of this decision, not a separate one.

## Resolution

**Choice: Azure Functions timer trigger, on the Flex Consumption plan.**

Decided over Container Apps Jobs on two points put to the human directly:

- **Packaging tax accepted**: zip deploy via an esbuild/tsup bundle, wrapping the proof
  task in the Functions v4 `app.timer(...)` handler — over maintaining a Dockerfile +
  container registry for a single tiny greenfield service. This worker has no native
  dependencies (`sharp`/`unrs-resolver`, per the packaging research, belong to the Next.js
  dashboard only), so bundling is clean: no `node_modules`, so none of the pnpm-symlink /
  `workspace:*` problems that break Functions run-from-package ever come up.
- **No automatic retry required**: this is a daily proof-of-foundation run, not a critical
  pipeline. A failed run surfaces via the platform's own failure status (below) and next
  scheduled slot just tries again — removing Container Apps Jobs' `replicaRetryLimit` as a
  deciding factor.

**Schedule**: NCRONTAB timer trigger, UTC (Flex Consumption has no timezone setting
regardless) — matches the UTC design already baked into the proof task's prompt
(ticket 03).

**Runtime fit**: the proof task runs well under 60 s (ticket 03: two model calls + one
local tool round-trip), comfortably inside the 30-minute `functionTimeout` default. The
30 s app-init limit is worth a flag for the implementation effort — `createAgent`
construction is lightweight, but this is the one timeout worth checking against in
practice.

**Secrets**: `OPENAI_API_KEY` — the single secret the proof task needs — is delivered as
a Key Vault reference in Function app settings, resolved via system-assigned managed
identity holding the "Key Vault Secrets User" role. No secret value ever lands in this
tracker or the deploy artifact.

**Observability — how a run's logs land, and how a failure surfaces:**

- Application Insights is the default integration on Functions and is the most polished
  monitoring story of the shortlisted options: automatic invocation traces and dependency
  calls to the OpenAI API, with no extra wiring.
- Ticket 03's structured JSON "run report" line
  (`{"event":"proof-run","outcome":...}`) written to stdout lands in App Insights traces —
  a human verifies a run by querying for that event over the last 24 h, one row expected
  per scheduled slot (a missing row means the run never started, per ticket 03).
- **Failure**: an uncaught error / non-zero exit marks the invocation **Failed** in the
  Functions invocation history and App Insights' Failures view. There is no automatic
  retry (decided above); the timer's `isPastDue` flag surfaces a missed occurrence, and a
  failed run simply waits for tomorrow's scheduled slot — checking platform run history
  counts as "noticing," per ticket 03. No active alerting is wired up at this stage.

**Cost**: on-demand billing, effectively **$0** at 1 run/day — well inside the monthly
free grant (250,000 executions + 100,000 GB-s), and further bounded by the Free Trial
subscription's spending-limit-ON hard $0 ceiling (ticket 04) through 2027-08-27 or an
upgrade off the free trial.

**IaC**: an official azd TypeScript timer-trigger starter template exists — the
strongest template coverage of the shortlisted options; Bicep and Terraform
(`azurerm_function_app_flex_consumption`) are both documented as fallbacks.

**Deferred to later tickets**: the exact Node version pin (22 vs 24) and the worker's
monorepo path/bundler config location go to ticket "Decide the worker's place in the
monorepo and its packaging"; resource naming, Key Vault setup, and where the NCRONTAB
cadence value itself lives (code vs IaC vs portal) go to ticket "Decide IaC tool,
resource structure, naming, and secrets strategy" — both now fully unblocked by this
decision plus the subscription-access ticket.
