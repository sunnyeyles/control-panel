# Azure foundation

Bicep behind `azd`, for the scheduled `@workspace/briefing-worker` service.
`azure.yaml` at the repo root is the manifest; everything here is what it
provisions.

| File                 | Role                                                       |
| -------------------- | ---------------------------------------------------------- |
| `main.bicep`         | Subscription-scoped entry point; resource group and budget |
| `app/worker.bicep`   | Flex Consumption function app, Node 22, system-assigned MI |
| `app/keyvault.bicep` | Empty RBAC-model vault — never the secret value            |
| `app/rbac.bicep`     | All role assignments, including Key Vault Secrets User     |
| `app/vnet.bicep`     | Only when `vnetEnabled` — off by default                   |

Adapted from `Azure-Samples/functions-quickstart-typescript-azd-timer`.

Node 22 on Flex Consumption in `australiaeast` was confirmed before pinning it,
and is the platform default there:

```
$ az functionapp list-flexconsumption-runtimes --location australiaeast --runtime node
Default    Name    Version    EndOfLifeDate
---------  ------  ---------  ------------
False      node    24         2029-04-30
True       node    22         2027-04-30
False      node    20         2026-04-30
```

## Naming

The starter's own scheme is kept rather than a hand-invented one: CAF
abbreviations plus `resourceToken`, where the token is
`uniqueString(subscription().id, environmentName, location)`. Only the resource
group carries the environment name.

```
rg-briefing            resource group
func-worker-<token>    function app
st<token>              storage (a Functions platform requirement)
appi-<token>           Application Insights
log-<token>            Log Analytics
plan-<token>           Flex Consumption plan
kv-<token>             Key Vault
```

`kv-<token>` is 16 characters, comfortably inside Key Vault's 24-character cap.
The cap was only ever a risk under a hand-written `kv-briefing-<token>`.

## First provision

Nothing below has been run yet — the template is reviewed and compiles, but no
Azure resources exist.

```bash
azd env select briefing                    # australiaeast, already created
azd env set BUDGET_ALERT_EMAIL you@example.com
azd provision
```

`budgetAlertEmail` has no default, so azd prompts for it on a first provision
and the cost guardrail cannot go missing because a step was forgotten.

Setting it to an empty string explicitly is the escape hatch if the Free Trial
offer rejects Cost Management budgets — the deployment fails fast on the budget
resource, and an empty value skips it. Re-set it after converting to
pay-as-you-go, which is exactly when the guardrail starts to matter: the trial's
spending limit is the only hard ceiling, and it disappears on conversion.

## The one manual step

The `OPENAI_API_KEY` value is set once, by hand, and never by a pipeline:

```bash
az keyvault secret set \
  --vault-name "$(azd env get-value AZURE_KEY_VAULT_NAME)" \
  --name openai-api-key \
  --value '<the key>'
```

Bicep provisions the vault and the role assignment; the value exists in exactly
one place. The function app reads it through an app setting that is a
`@Microsoft.KeyVault(SecretUri=...)` reference, resolved by the app's own
system-assigned identity holding **Key Vault Secrets User**. The URI carries no
version, so rotating the secret needs no redeploy.

Then deploy and confirm the setting resolves:

```bash
azd deploy worker
```

## Verifying a run

The definition of success is one query, in Application Insights logs:

```kusto
traces
| where timestamp > ago(24h)
| where message has "proof-run"
| project timestamp, message
```

One `"outcome":"success"` row per scheduled slot (09:00 UTC daily). A missing
row means the run never started — which exit codes alone cannot tell you.
Failures also appear as Failed invocations in the function's run history and in
the Failures view. There is no automatic retry and no alerting, by decision: a
failed run waits for tomorrow's slot.

## CI/CD

`.github/workflows/deploy-briefing-worker.yml` deploys on a push to `main` that
touches the worker, the agent packages, or this directory. It authenticates
with OIDC federated credentials, so no service-principal secret is stored.

The credential and repo variables it reads are not yet created. Run:

```bash
azd pipeline config --auth-type federated
```

which creates the app registration plus the federated credential and sets
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ENV_NAME`
and `AZURE_LOCATION` on the repository. Add `BUDGET_ALERT_EMAIL` alongside them.
The workflow reads these as repository **variables** (`vars.*`); if they land as
secrets instead, change the references in the workflow to match.
