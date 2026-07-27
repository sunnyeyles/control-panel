# Research: Azure options for a scheduled Node.js/TypeScript agent job

Researched 2026-07-27 against current Microsoft Learn docs and Azure pricing pages.
Workload assumed: LangGraph agent in Node.js/TypeScript, outbound HTTPS to the
OpenAI API, runtime seconds-to-minutes, ~1 run/day.

---

## 1. Azure Container Apps Jobs (scheduled trigger)

Docs: <https://learn.microsoft.com/en-us/azure/container-apps/jobs>

- **Schedule**: native `Schedule` trigger type with a standard **5-field cron
  expression**, evaluated in **UTC** (no time-zone setting). Sub-minute cadence
  is not expressible; daily (`0 6 * * *`) is trivially supported.
- **Packaging**: container image (any registry; ACR with managed-identity
  pull). Any Node.js version — you own the base image.
- **Timeout / retries**: `replicaTimeout` (seconds) is required and caps each
  execution (examples use 1800s; set it to whatever the job needs).
  `replicaRetryLimit` gives automatic retries on failure; `parallelism` /
  `replicaCompletionCount` default to 1 for simple jobs.
- **Secrets**: first-class **Key Vault references** on app-level secrets using
  system- or user-assigned **managed identity** (identity needs the "Key Vault
  Secrets User" RBAC role); secrets surface as env vars via `secretRef` or as
  volume-mounted files. Unversioned KV URIs auto-pick-up new secret versions
  within ~30 min. <https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets>
- **Logging/monitoring**: environment-level Log Analytics / Azure Monitor;
  execution history in the portal is capped at the most recent 100 succeeded +
  failed executions — full logs come from the environment's log provider.
- **Cold start**: every execution starts a fresh replica (pod), so startup =
  scheduler tick + image pull + container boot; typically seconds to ~a minute.
  Irrelevant for a daily batch job. Sidecar (Envoy) readiness is guaranteed
  before the job container starts, so outbound calls at startup work.
- **Cost at 1 run/day**: consumption billing "from its start to completion; no
  usage charges apply when a job is not running executions." Monthly free
  grant: **180,000 vCPU-s + 360,000 GiB-s + 2M requests** — a daily
  minutes-long run at 0.25 vCPU/0.5 GiB is deep inside the free grant, so
  effectively **$0** (plus pennies for Log Analytics ingestion and ACR Basic
  ~$5/mo if you need a private registry).
  <https://azure.microsoft.com/en-us/pricing/details/container-apps/>
- **IaC**: good. ARM/Bicep `Microsoft.App/jobs` documented with full examples;
  `az containerapp job create` CLI; Terraform `azurerm_container_app_job`;
  azd supports Container Apps environments. Restrictions: no Dapr, no ingress
  (fine for a batch job).

## 2. Azure Functions timer trigger (Flex Consumption plan)

Docs: <https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan>,
<https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-timer>

- **Schedule**: **NCRONTAB** expression (6 fields with seconds, 5-field also
  accepted), default UTC. Note: `WEBSITE_TIME_ZONE` / `TZ` are **not supported
  on Flex Consumption** (Linux-only plan), so schedules are UTC, period.
  Singleton semantics across scale-out (storage-lock coordinated);
  `isPastDue` flag for missed occurrences. **No automatic retry** — a failed
  run waits for the next scheduled occurrence (add retry policy in code).
- **Packaging**: **zip deploy** of the built app to a blob container (single
  deployment path; no container image on Flex). Requires adopting the Functions
  Node v4 programming model (`app.timer(...)` handler) — a thin wrapper around
  the existing LangGraph entry point.
- **Node versions**: **Node.js 22 and 24** supported on Flex Consumption.
- **Timeout / cold start**: timer functions are not subject to the 230s HTTP
  limit; run duration is governed by `functionTimeout` in host.json (default
  30 min, effectively unbounded per plan docs:
  <https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale>).
  Scale-to-zero cold starts apply but are reduced vs. classic Consumption;
  optional "always ready" instances eliminate them (at a cost). App
  initialization itself times out at 30s — keep startup light.
- **Secrets**: standard App Service **Key Vault references** in app settings
  with managed identity; identity-based (secretless) connections to the
  required host storage account are supported.
- **Logging/monitoring**: Application Insights integration is the default and
  is the most polished monitoring story of the group (invocation traces,
  failures, dependency calls to the OpenAI API).
- **Cost at 1 run/day**: on-demand billing per GB-s and per execution;
  monthly free grant **250,000 executions + 100,000 GB-s**; on-demand rates
  ~$0.000026/GB-s and $0.40/M executions past the grant. One daily
  minutes-long run is effectively **$0** (small fixed costs: required Storage
  account, App Insights ingestion).
  <https://azure.microsoft.com/en-us/pricing/details/functions/>
- **IaC**: strong. First-class **azd** templates including a TypeScript timer
  starter (<https://learn.microsoft.com/en-us/samples/azure-samples/functions-quickstart-typescript-azd-timer/starter-timer-trigger-typescript/>),
  Bicep samples in the Flex Consumption samples repo, Terraform azurerm
  supports Flex (`azurerm_function_app_flex_consumption`). Caveats: one app
  per plan; no deployment slots; regional availability list still applies.

## 3. Azure Container Instances + external scheduler

Docs: <https://learn.microsoft.com/en-us/azure/connectors/connectors-create-api-container-instances>

- **Schedule**: **none built in.** ACI has no cron; you pair a container group
  with an external trigger — typically a Logic App with a Recurrence trigger
  using the ACI connector (create/start container group, poll, fetch logs,
  delete), or an Azure Functions/DevOps pipeline doing the same.
- **Packaging**: container image, any Node version.
- **Timeout / cold start**: no execution timeout concept (you run until the
  process exits; `restartPolicy: Never` for batch). Each start pulls the image
  — startup latency tens of seconds. The scheduling half (start, wait,
  reap, alert on failure) is yours to build and debug.
- **Secrets**: secure environment variables and secret volumes; **managed
  identity is supported inside the container** so code can fetch from Key
  Vault at runtime — but there is no declarative KV-reference-to-env-var
  mechanism like ACA/Functions have.
- **Logging/monitoring**: `az container logs`, optional Log Analytics via
  diagnostics; no per-execution history — you assemble it from the Logic App
  run history plus container logs.
- **Cost at 1 run/day**: per-second, **no free grant**: ~$0.0000135/vCPU-s +
  ~$0.0000015/GB-s (Linux). A daily 2-min run at 1 vCPU/1.5 GB is roughly
  **$0.05/month**, plus Logic Apps action charges (pennies). Cheap, but not
  cheaper than the free-grant options.
  <https://azure.microsoft.com/en-us/pricing/details/container-instances/>
- **IaC**: ACI itself is fine in Bicep/Terraform, but the scheduler wiring is
  a second resource (Logic Apps workflow JSON in ARM, or
  `azurerm_logic_app_workflow` + hand-rolled action JSON) — the weakest
  overall IaC story here relative to what you get for it.
- **Verdict-shaping fact**: this is exactly the gap ACA Jobs was built to
  close; Microsoft's own guidance steers scheduled containers to ACA Jobs.

## 4. AKS CronJob

- **Schedule**: Kubernetes-native `CronJob` — full cron semantics, per-job
  time zones (`spec.timeZone`), `concurrencyPolicy`, `startingDeadlineSeconds`,
  history limits. The most expressive scheduler of the group.
- **Packaging**: container image, any Node version.
- **Secrets**: K8s Secrets; Key Vault via the **Azure Key Vault provider for
  Secrets Store CSI Driver** add-on with workload identity
  (<https://learn.microsoft.com/en-us/azure/aks/csi-secrets-store-driver>) —
  works well but is an add-on to configure, not a one-liner.
- **Logging/monitoring**: Container Insights / Azure Monitor for the cluster;
  per-pod logs. Mature, but cluster-grade.
- **Timeout / cold start**: `activeDeadlineSeconds` per job; pod start on an
  already-running node is fast (seconds).
- **Cost at 1 run/day**: the control plane Free tier is $0
  (<https://azure.microsoft.com/en-us/pricing/details/kubernetes-service/>),
  but you pay for **nodes 24/7** — even a single small B-series/D2 node is
  roughly **$30–80/month**, i.e. orders of magnitude more than every other
  option, unless a cluster already exists. Plus cluster upkeep (upgrades,
  node patching).
- **IaC**: excellent for the cluster (Bicep/Terraform/azd), but adds a second
  IaC layer (K8s manifests/Helm/Flux) for the CronJob itself.
- **Verdict-shaping fact**: only rational if an AKS cluster already exists;
  this repo has none.

## 5. Logic Apps (as orchestrator)

- **Schedule**: **Recurrence trigger** — intervals from seconds up, with time
  zone and start-time support
  (<https://learn.microsoft.com/en-us/azure/connectors/connectors-native-recurrence>).
  A genuinely good scheduler.
- **The catch**: Logic Apps **cannot run Node.js/LangGraph code** — inline
  code actions are limited JavaScript snippets, not an npm/LangGraph runtime.
  It can only orchestrate other compute (ACI connector, HTTP call to a
  Function, etc.), so it is a scheduler component, not a compute answer.
- **Secrets**: Key Vault connector / managed identity for the workflow's own
  connections.
- **Logging/monitoring**: run history per workflow run is excellent for
  "did last night's run happen" auditing.
- **Cost at 1 run/day**: Consumption tier — ~$0.000025 per built-in action,
  ~$0.000125 per standard connector call; a daily few-action run is
  **well under $1/month**. (Triggers bill as actions on every poll — at daily
  cadence, negligible.)
  <https://azure.microsoft.com/en-us/pricing/details/logic-apps/>
- **IaC**: workflow definitions are verbose ARM/Bicep JSON; Terraform support
  (`azurerm_logic_app_workflow`) requires embedding action JSON. Serviceable,
  not pleasant.
- **Verdict-shaping fact**: only relevant paired with ACI (option 3) or as an
  extra audit layer; both shortlisted options have native schedulers, making
  it redundant here.

---

## Shortlist

**1. Azure Container Apps Jobs (scheduled) — best overall fit.**
The code ships as a container, so the existing pnpm/Turborepo build, Node
version, and LangGraph entry point run unchanged — no framework adoption.
Native cron trigger, configurable timeout and retries, Key Vault references
via managed identity, scale-to-zero billing that lands inside the monthly free
grant at 1 run/day, and solid Bicep/CLI/Terraform coverage. The main tax is
maintaining a Dockerfile + registry and UTC-only cron.

**2. Azure Functions timer trigger on Flex Consumption — best if adopting the
Functions model is acceptable.**
No Dockerfile or registry: zip deploy of Node 22/24 code with an NCRONTAB
timer, the strongest out-of-the-box monitoring (App Insights), Key Vault
references, effectively $0 at this cadence, and the best azd/Bicep template
story (an official TypeScript timer azd starter exists). The tax is wrapping
the agent in the Functions v4 programming model, UTC-only schedules on Flex,
no built-in retry on a failed timer run, and the 30s app-init limit.

Not shortlisted: ACI + external scheduler (you hand-build the scheduling and
observability ACA Jobs gives you for free, for no savings), AKS CronJob
(~$30–80/mo of always-on nodes and cluster upkeep for a daily minutes-long
job), Logic Apps alone (cannot host the Node/LangGraph runtime).

The decision between the two shortlisted options is deferred to the
human-in-the-loop decision ticket.
