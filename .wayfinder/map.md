# Azure foundation for the daily briefing service

<!-- labels: wayfinder:map -->

## Destination

A locked set of decisions — recorded on this map's tickets — that fully specifies the Azure project structure and deployment foundation for the daily-briefing capability, proven out on paper by the design of one scheduled service that runs on a cadence and executes a trivial agent task. Done means nothing is left to decide before an implementation effort can go build it. Building and deploying is **not** on this map.

## Notes

- **Planning only** (wayfinder default, no override): tickets resolve decisions, not deliverables. The one exception is the type:task tickets, which do only what a decision is blocked on.
- The scheduled service is **TypeScript/Node**, consuming the existing workspace packages (`@workspace/agents`, `@workspace/agents-core`, `@workspace/agent-tools`). The historical Python/LangChain direction is dead.
- Azure is a **greenfield personal subscription** — no org conventions to inherit; naming, IaC, and structure are this map's to decide.
- Skills to consult per session: `codebase-design` (for monorepo placement/seams), `domain-modeling` (to keep briefing-domain terms consistent).
- Repo facts that bind decisions: pnpm workspace with `symlink=true` load-bearing in `.npmrc`; agent packages consumed as built `dist/`; no test infrastructure exists; `OPENAI_API_KEY` is read at agent construction time.

### Tracker conventions (local markdown)

This directory is the tracker. Each ticket is a file under `.wayfinder/tickets/`, its frontmatter holding tracker state:

- `type`: research | prototype | grilling | task — the `wayfinder:<type>` label.
- `status`: open | closed.
- `assignee`: empty means unclaimed; a session claims a ticket by writing a name here **before** working it.
- `blocked-by`: list of ticket filenames; a ticket is unblocked when every listed ticket has `status: closed`.
- **Frontier** = open + unassigned + all blockers closed. List it with:
  `grep -l "status: open" .wayfinder/tickets/*.md` then check each file's `assignee`/`blocked-by`.
- Resolutions are appended to the ticket body under `## Resolution`; assets go in `.wayfinder/assets/` and are linked, not pasted.

## Decisions so far

<!-- one line per closed ticket: gist + link; detail lives only in the ticket -->

- [Research: Azure options for scheduled Node.js jobs](tickets/01-research-scheduled-compute-options.md) — shortlist of two, both effectively $0 at 1 run/day: Container Apps Jobs (container packaging, native cron, Key Vault refs, retries) and Functions timer on Flex Consumption (zip deploy, best monitoring, but UTC-only, no retry, 30s init limit). ACI, AKS CronJob, and Logic Apps ruled out. Decision deferred to its ticket.
- [Research: deploying one app from a pnpm + Turborepo workspace to Azure](tickets/02-research-pnpm-monorepo-deploy.md) — fact base in hand: `turbo prune --docker` + multi-stage Dockerfile for container targets; esbuild/tsup single-file bundle for zip-deploy (pnpm symlinks don't survive Azure run-from-package); `pnpm deploy --prod` only for folders consumed in place. Packaging decision itself deferred to its ticket.
- [Proof task and observable success](tickets/03-define-proof-task-and-success.md) — one `createAgent` invocation with only `getCurrentTime`, fixed UTC prompt forcing a tool round-trip; success defined structurally (no throw, clean END, ≥1 non-error tool result), signalled by exit code (authoritative) plus one JSON "run report" log line queried in Log Analytics/App Insights. **No persistence primitive in the foundation.** Pins for the compute choice: <60 s runtime, egress to `api.openai.com` only, single secret `OPENAI_API_KEY`, logs-to-workspace required.
- [Task: Azure subscription and tooling access](tickets/04-azure-subscription-and-tooling-access.md) — `az` 2.88.0 installed and logged in; Free Trial subscription (spending limit ON, free-tier promo to 2027-08-27), tenant and subscription IDs recorded on the ticket; default region `australiaeast` (inferred from machine timezone, overridable).

## Not yet specified

- The multi-environment story (dev vs prod, or single environment) — hangs on the IaC and resource-structure decision.
- Cost guardrails on the personal subscription (budgets, alerts, spend ceiling for the scheduled runs) — hangs on subscription setup and compute choice.
- How the cadence is configured and changed after deploy (in code, in IaC, in the portal) — hangs on the compute-service choice.

## Out of scope

- The real briefing agent — data sources (Gmail etc.), prompts, tool wiring, briefing content. This map's agent task is deliberately trivial.
- Surfacing briefings in the dashboard, and hosting the Next.js dashboard itself on Azure.
- Choosing or wiring up a test framework (the repo has none; that's its own effort).
- Multi-user or auth concerns — the platform is single-user today.
