# Handoff spec: Azure foundation for the daily briefing service

<!-- Produced by ticket 09. This is the document an implementation effort starts
from. It sequences the map's decisions and links each ticket for rationale and
detail — it does not restate them at length. Every decision below is settled;
nothing on the map is left open. -->

## What gets built

One scheduled Azure service that runs daily and executes a trivial agent task,
proving the whole deployment foundation end to end: a new workspace app
(`apps/briefing-worker`) bundled to a single file, deployed as an Azure
Functions timer on Flex Consumption via azd + Bicep, secret from Key Vault,
verified through App Insights, shipped by a GitHub Actions pipeline. The real
briefing agent is explicitly **not** part of this build (see Out of scope).

## Prerequisites (already true — verify, don't redo)

- `az` CLI ≥ 2.88.0 installed and logged in; tenant and subscription IDs are
  recorded on [ticket 04](../tickets/04-azure-subscription-and-tooling-access.md).
  Free Trial subscription, spending limit ON, free-tier promo to 2027-08-27.
- Default region: **`australiaeast`** (ticket 04).
- The `OPENAI_API_KEY` value is at hand for the one manual secret step (step 5).
  Its value never enters the repo, the tracker, or any pipeline.
- `azd` (Azure Developer CLI) installed.

## Build sequence

Each step names its governing ticket(s); open the ticket before implementing
the step — the tickets carry the full contracts, this spec only sequences them.

### 1. Scaffold `apps/briefing-worker` — [ticket 06](../tickets/06-monorepo-placement-and-packaging.md)

Package `@workspace/briefing-worker`, private, `"type": "module"`, Node 22
(pin in `engines.node`). Dependencies: `@workspace/agents-core` and
`@workspace/agent-tools` **only** — not `@workspace/agents`. Layout per the
ticket, with the trigger/task seam:

- `src/functions/scheduledRun.ts` — shallow: `app.timer()` registration only.
- `src/runScheduledTask.ts` — deep: owns the entire task + success contract.
- `src/index.ts`, `host.json`, gitignored `local.settings.json`, `build.mjs`.

Packaging: **esbuild invoked directly** from `build.mjs` (human's explicit
choice over tsup) — entry `src/index.ts`, `bundle: true`, `format: "esm"`,
`target: "node22"`, out `dist/index.js`, `@azure/functions` bundled in. A
`zip` script produces `functionapp.zip` (dist contents + `host.json`).
**No `turbo.json` changes** — existing `build`/`typecheck` wiring already
covers this app.

### 2. Implement the proof task — [ticket 03](../tickets/03-define-proof-task-and-success.md)

`runScheduledTask.ts`: `createAgent` from `@workspace/agents-core` with exactly
one tool (`getCurrentTime` from `@workspace/agent-tools/time`), invoked once
with the fixed UTC prompt from the ticket. Success is **structural** (no throw,
clean `END`, ≥1 non-error `get_current_time` tool result). Emit exactly one
JSON **run-report** line to stdout per the ticket's schema; exit `0`/non-zero
as the authoritative signal (in Functions terms: return normally vs. throw so
the invocation is marked Failed). No persistence primitive of any kind.

### 3. Wire the timer — tickets [05](../tickets/05-choose-compute-service.md) / [07](../tickets/07-iac-resource-structure-and-secrets.md)

`scheduledRun.ts` registers the NCRONTAB schedule **`0 0 9 * * *`** (09:00 UTC
daily) directly in code — no app-setting indirection. Changing cadence =
editing that string and redeploying.

### 4. IaC — [ticket 07](../tickets/07-iac-resource-structure-and-secrets.md), plus [ticket 10](../tickets/10-cost-guardrails.md)

`azd init` from the official azd **TypeScript Functions-timer starter**;
`azure.yaml` and `infra/` live at the **repo root**
(`services.worker.project: ./apps/briefing-worker`, `language: ts`,
`host: function`). Then adapt:

- azd environment name **`briefing`**, region `australiaeast`. Single
  environment, no dev/prod split. Single resource group.
- Naming: keep the starter's own CAF-abbreviation + `resourceToken` scheme —
  do not invent names. Expected shape (confirm at init): `rg-briefing`,
  `func-briefing-<token>`, `st<token>`, `appi-briefing-<token>`,
  `log-briefing-<token>`, `kv-briefing-<token>`.
- Function app: Flex Consumption, Node 22, **system-assigned managed
  identity**.
- Key Vault: RBAC model (`enableRbacAuthorization: true`); role assignment
  **Key Vault Secrets User** to the function app's identity; app setting
  `OPENAI_API_KEY` = `@Microsoft.KeyVault(SecretUri=...)` reference to secret
  **`openai-api-key`**. Bicep provisions the empty vault + role only — never
  the value.
- The Functions-mandated storage account is a platform requirement the starter
  provisions; the worker's code never touches it (not a ticket 03 violation).
- **Budget (ticket 10):** subscription-scoped `Microsoft.Consumption/budgets`
  in `main.bicep` — USD 5/month, actual-cost alerts 50/90/100% + 100%
  forecast, email via azd env parameter `BUDGET_ALERT_EMAIL`.

### 5. Provision, then the one manual secret step — [ticket 07](../tickets/07-iac-resource-structure-and-secrets.md)

`azd provision`, then once, by hand:

```
az keyvault secret set --vault-name kv-briefing-<token> \
  --name openai-api-key --value <key>
```

This is the only manual step in the whole foundation and is never automated.

### 6. Deploy and verify — tickets [03](../tickets/03-define-proof-task-and-success.md) / [05](../tickets/05-choose-compute-service.md)

`azd deploy` (or `azd up`). Verification is the ticket 03 query: in App
Insights traces, filter `event == "proof-run"` over the last 24 h — one
`outcome == "success"` row per scheduled slot; a missing row means the run
never started. Failures appear as Failed invocations in the Functions run
history / App Insights Failures view. No automatic retry, no active alerting —
by decision, not omission.

### 7. CI/CD — [ticket 08](../tickets/08-cicd-pipeline-shape.md)

`azd pipeline config` scaffolds the GitHub Actions workflow: **OIDC federated
credentials** (no stored service-principal secret), triggers = push to `main`
scoped by `on.push.paths` (`apps/briefing-worker/**`, the three agent
packages, `infra/**`, `azure.yaml`) **plus** unfiltered `workflow_dispatch`.
One combined pipeline (`azd up` semantics), not split infra/code workflows.
The build step runs `pnpm turbo build --filter=@workspace/briefing-worker` so
`^build` ordering builds the agent packages first.

## Conditionals to check at implementation time

The only places a resolution left something to verify rather than decided:

1. **Node 22 on Flex Consumption in `australiaeast`** — confirm with
   `az functionapp list-flexconsumption-runtimes` (ticket 06).
2. **30 s app-init limit** — `createAgent` construction is expected to be
   lightweight, but this is the one Flex Consumption timeout worth checking in
   practice (ticket 05).
3. **azd starter's actual resource names** — the expected names above are the
   standard starter shape; confirm at `azd init`, especially the Key Vault's
   24-char truncation (ticket 07). Do not hand-write a longer vault name.
4. **Budget support on the Free Trial offer** — the budget resource fails fast
   if the offer type doesn't support Cost Management budgets; if so, comment it
   out and enable at pay-as-you-go conversion (ticket 10).

## Done when

- The timer fires daily at 09:00 UTC and the App Insights query shows one
  `proof-run` success row per slot (ticket 03's definition, nothing else).
- A push to `main` touching the worker or infra reaches Azure with no manual
  action; a dashboard-only push doesn't trigger the pipeline at all.
- The only secret material anywhere is the Key Vault secret set in step 5.

## Out of scope (from the [map](../map.md) — unchanged)

The real briefing agent (Tavily fan-out, orchestrator, Blob upload); surfacing
briefings in the dashboard; hosting the dashboard on Azure; test-framework
selection; multi-user/auth.
