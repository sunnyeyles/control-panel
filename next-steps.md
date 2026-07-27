# Next steps — from a reviewed template to a verified daily run

Everything in `infra/` and `apps/briefing-worker/` is authored, compiles, and
has been proven locally. **No Azure resource exists yet.** This file is the
ordered path from here to issue 04 closed, and says at each step why the step
is shaped the way it is.

Read `infra/README.md` for the topology and `apps/briefing-worker/README.md`
for the load-bearing build details. This file is the sequence; those are the
reference.

## Where we are

|                 |                                                         |
| --------------- | ------------------------------------------------------- |
| Branch          | `briefing-azure-foundation`, 6 commits, not merged      |
| Issues done     | 01, 02, 03, 05                                          |
| Issue open      | 04 — needs live Azure and a real 09:00 UTC slot         |
| azd environment | `briefing` — all four variables set                     |
| Azure resources | none                                                    |
| Proven locally  | build, cold boot under `func`, success run, failure run |

---

## Step 1 — Merge the branch to `main`

```bash
git add next-steps.md infra/README.md
git commit -m "Adds the topology diagram and the deployment runbook"
git checkout main
git merge briefing-azure-foundation
git push
```

**Why first.** The deploy workflow triggers on `push` to `main` with path
filters. While the work sits on a side branch, CI is inert — you could
provision and deploy by hand all day and never learn whether the pipeline
works. Merging is what makes the rest of this file testable.

**Why it is safe to merge before provisioning.** The push will start the
workflow, and it will fail at the Azure login step because the federated
credential does not exist yet (step 6). That failure is expected and costs
nothing. If you would rather not see a red run, do step 6 before pushing —
`azd pipeline config` works against a repo whose infra has never been applied.

---

## Step 2 — Provision the infrastructure

```bash
azd provision
```

**Why this is the first irreversible step.** Everything before it was text.
This creates eight billable resources under subscription
`49798f7a-…`. Expect five to ten minutes.

**What it creates.** A resource group `rg-briefing`, a Flex Consumption plan,
the function app with a system-assigned identity, a storage account, Key Vault,
Application Insights, Log Analytics, and a subscription-scoped budget. See the
topology diagram in `infra/README.md`.

**Why it is idempotent.** `azd provision` is a Bicep deployment, so re-running
it with unchanged templates is a no-op. You can safely run it again after a
partial failure rather than tearing down.

**Verify:**

```bash
az resource list --resource-group rg-briefing --output table
azd env get-values | grep -E 'KEY_VAULT|FUNCTION'
```

You want `AZURE_KEY_VAULT_NAME` and `AZURE_FUNCTION_NAME` populated — the rest
of this file uses them.

**If it fails on the budget.** Some Free Trial offers reject
`Microsoft.Consumption/budgets`. The escape hatch is deliberate:

```bash
azd env set BUDGET_ALERT_EMAIL ""
azd provision
```

The `if (!empty(budgetAlertEmail))` guard at `infra/main.bicep:272` skips the
resource. Re-set the email after converting to pay-as-you-go — that is exactly
when the guardrail starts earning its keep, because the trial's spending limit
is the only hard ceiling you have and it disappears on conversion.

**If the app reports it cannot reach storage.** Role assignments are eventually
consistent, and RBAC necessarily runs _after_ the function app because a
system-assigned identity has no principal ID until its host resource exists.
Wait a minute and re-check before debugging anything.

---

## Step 3 — Put the OpenAI key in Key Vault

```bash
az keyvault secret set \
  --vault-name "$(azd env get-value AZURE_KEY_VAULT_NAME)" \
  --name openai-api-key \
  --value '<the key>'
```

**Why by hand, and only ever by hand.** This is the one value in the system
that must not exist in git, in azd's environment files, or in a pipeline. Bicep
provisions the vault empty and grants the app's identity **Key Vault Secrets
User**; the value arrives through this command and lives in exactly one place.
Any design where the pipeline knows the key would put it in a log the first
time something went wrong.

**Why you do not set `OPENAI_API_KEY` on the function app.**
`infra/main.bicep:147` already sets it to a
`@Microsoft.KeyVault(SecretUri=…)` reference. Setting it by hand would replace
that reference with a literal and defeat the whole arrangement. The URI carries
no version, so rotating the secret later needs no redeploy — just re-run this
command.

**Why before the deploy.** Deploy first and the app starts with an app setting
it cannot resolve, which surfaces as a confusing runtime failure rather than an
obvious missing-secret one.

**Verify** the reference resolves — this is the real check, not that the secret
exists:

```bash
az functionapp config appsettings list \
  --name "$(azd env get-value AZURE_FUNCTION_NAME)" \
  --resource-group rg-briefing \
  --query "[?name=='OPENAI_API_KEY']" --output table
```

The portal shows a green tick against a Key Vault reference that resolved and a
red cross against one that did not. A red cross here almost always means RBAC
has not propagated yet, or the secret name does not match `openai-api-key`.

---

## Step 4 — Deploy the worker

```bash
pnpm turbo build --filter=@workspace/briefing-worker
azd deploy worker
```

**Why the explicit build.** `azure.yaml` has a `prepackage` hook that runs it
anyway, but running it yourself means a compile error is attributable to the
build rather than surfacing inside a deployment step.

**What actually ships.** The contents of `dist/` — one bundled `index.js`,
`host.json`, and a generated minimal `package.json` — and nothing else. In
particular never `node_modules`, whose pnpm symlinks do not survive
run-from-package mounting. That is why the worker is bundled by esbuild at all.

**Verify:**

```bash
az functionapp function list \
  --name "$(azd env get-value AZURE_FUNCTION_NAME)" \
  --resource-group rg-briefing --output table
```

`scheduledRun` should be listed. If the list is empty the bundle did not
register — the Functions v4 model finds the registering module through `main`
in the deployed `package.json`, so that is where to look.

---

## Step 5 — Force a run rather than waiting for 09:00 UTC

```bash
FUNC=$(azd env get-value AZURE_FUNCTION_NAME)
KEY=$(az functionapp keys list --name "$FUNC" --resource-group rg-briefing \
  --query masterKey --output tsv)

curl -X POST "https://$FUNC.azurewebsites.net/admin/functions/scheduledRun" \
  -H "x-functions-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":""}'
```

**Why not just wait.** The next scheduled slot could be twenty-three hours
away. Finding out then that the secret reference is misconfigured wastes a day
per iteration. This is the same admin endpoint used locally, with a master key
because the deployed host is authenticated.

**Why this does not close issue 04.** The ticket asks for a _scheduled_ run,
not a triggered one — a manual trigger proves the code and the secret work, but
not that the timer fires. Both are needed; this one is just available now.

---

## Step 6 — Confirm the run the way the ticket defines success

In Application Insights → Logs:

```kusto
traces
| where timestamp > ago(24h)
| where message has "proof-run"
| project timestamp, message
```

**Why a log query and not an exit code.** The failure this service is most
likely to suffer is _not running at all_ — a broken schedule, a stopped app, a
deploy that unregistered the function. An exit code cannot report its own
absence. One row per expected slot is the only check that catches silence,
which is why ticket 03 made this query the definition of success rather than a
nice-to-have.

**Why sampling is off in `host.json`.** The starter enables it. At one row per
day, a sampled-out line would read as "the run never started" — the exact false
signal this check exists to catch.

**Measuring cold start (issue 04's third box).** The proof-run line carries its
own `durationMs`, which times `runScheduledTask` only. Compare it against the
invocation's total duration in the Functions run history: the gap is host
startup plus module load. Flex Consumption allows 30 s for app init, and the
design keeps well clear of it deliberately — agents are exported as `createX()`
factories, so no model is constructed at import time. If that gap ever
approaches the limit, something has moved work into module scope.

---

## Step 7 — Prove the failure contract survives deployment

Temporarily break the secret reference, force a run, then restore it:

```bash
az keyvault secret set --vault-name "$(azd env get-value AZURE_KEY_VAULT_NAME)" \
  --name openai-api-key --value 'sk-deliberately-invalid'
# force a run as in step 5, then:
az keyvault secret set --vault-name "$(azd env get-value AZURE_KEY_VAULT_NAME)" \
  --name openai-api-key --value '<the real key>'
```

**Why bother.** A monitoring story that only ever sees success is untested.
This confirms the run appears as a **Failed** invocation and emits one
`"outcome":"failure"` line — the same contract proven locally, but across the
deployment boundary. Without it you would not know whether a real failure would
be visible or silent.

**Why an invalid value rather than deleting the secret.** Deleting it puts the
app setting into an unresolved state that persists until the app restarts,
which is a slower and messier thing to undo.

---

## Step 8 — Wire up CI

```bash
azd pipeline config --auth-type federated
gh variable set BUDGET_ALERT_EMAIL --body sunnyeyles@gmail.com
gh variable list
```

**Why federated rather than a client secret.** OIDC means GitHub mints a
short-lived token per run and no long-lived credential is stored in the repo.
There is no secret to rotate and none to leak.

**The check that matters.** The workflow reads all six values as `vars.*`. If
`azd pipeline config` creates them as _secrets_ instead, the job runs with
empty strings and fails at login with an unhelpful message. `gh variable list`
should show `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_ENV_NAME`, `AZURE_LOCATION`, `BUDGET_ALERT_EMAIL`. If they landed as
secrets, change the references in the workflow to match.

**Why `AZURE_PRINCIPAL_TYPE` is not in that list.** The workflow hardcodes it
to `ServicePrincipal`, because in CI the deployer is the pipeline's principal,
not you, and Azure rejects a role assignment whose `principalType` contradicts
the principal. Locally it defaults to `User`. This is the one value that must
differ between the two contexts.

Then test the pipeline without a code change:

```bash
gh workflow run deploy-briefing-worker.yml
```

**Why `workflow_dispatch` is unfiltered.** The push trigger is path-scoped, so
a dashboard-only commit does not start the workflow at all. But a manual run
should always run — that is what makes this test possible without an empty
commit.

---

## Step 9 — Close issue 04

Wait for one real 09:00 UTC slot, then re-run the query from step 6. The ticket
closes when all four boxes hold:

- [ ] `azd deploy` succeeds from a clean checkout — steps 2–4
- [ ] A **scheduled** invocation returns a success row — this step
- [ ] Cold-start app init stays inside 30 s, observed figure recorded — step 6
- [ ] A deliberately failed run appears as a Failed invocation — step 7

Only the second requires the wait. Everything else is already demonstrable
after step 7, so record those results as you go rather than re-deriving them
tomorrow.

---

## After that

**The seam is `runScheduledTask.ts`.** Replacing the proof task with the real
briefing means changing the body of that one function. The schedule, the
Functions binding, the run-report shape, and every piece of infrastructure
above stay exactly as they are — that split is the whole point of the two-module
design.

**There is still no test framework.** That was deliberate and in scope for the
handoff spec, but the moment `runScheduledTask` does something with real
branching, the absence starts to cost. Choosing and wiring a runner is the
natural next piece of work.

**Turning it all off** costs one command:

```bash
azd down --purge
```

`--purge` matters — without it the Key Vault stays in soft-deleted limbo for
seven days and blocks a re-provision that wants the same name.
