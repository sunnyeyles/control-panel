# Next steps — from a deployed worker to a verified daily run

The foundation is live. This file is what remains, in order, and why each step
is shaped the way it is.

`infra/README.md` holds the topology and the operational gotchas;
`apps/briefing-worker/README.md` holds the build details. This file is the
sequence.

## Where we are

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| Branch      | `main`, pushed                                             |
| Issues done | 01, 02, 03, **05 verified end to end in CI**               |
| Issue open  | 04 — one box left, and it needs a real 09:00 UTC slot      |
| Azure       | provisioned, worker deployed, `scheduledRun` registered    |
| Pipeline    | green: preflight → build → OIDC login → provision → deploy |
| Blocked on  | the OpenAI key                                             |

Already done and not repeated below: merge and push, provision (via CI), deploy,
`azd env refresh`, the federated-credential fix, and granting the deployer
Key Vault Secrets Officer by hand.

---

## Step 1 — Rotate the OpenAI key

The key was pasted into a chat transcript and into shell history in plaintext.
Revoke it at platform.openai.com, issue a new one, then:

```bash
az keyvault secret set --vault-name kv-5ngerafeorjcg --name openai-api-key --value "$(pbpaste)"
```

**Why `"$(pbpaste)"`.** A literal `--value sk-...` is recorded in
`~/.zsh_history` and printed in scrollback, and scrollback is what gets pasted
elsewhere. Reading from the clipboard keeps the value off both. Clear the old
one out of history too — search for `sk-proj-`.

**Why this is first.** Every other step below is worthless while a live key is
loose, and this is the only step with a clock on it.

---

## Step 2 — Restart the app, then confirm the reference resolves

```bash
az functionapp restart -g rg-briefing -n func-worker-5ngerafeorjcg

# wait ~30s — want the single word "Resolved"
az rest --method get --uri "https://management.azure.com/subscriptions/49798f7a-1699-4f48-9133-a4139b6fb828/resourceGroups/rg-briefing/providers/Microsoft.Web/sites/func-worker-5ngerafeorjcg/config/configreferences/appsettings?api-version=2022-03-01" \
  --query "value[?name=='OPENAI_API_KEY'].properties.status" -o tsv
```

**Why a restart is needed at all.** App Service resolves
`@Microsoft.KeyVault(...)` references when the app starts and caches the result.
This app started before the secret existed, so the setting is pinned at
`SecretNotFound` regardless of what the vault holds now. Setting the secret does
not clear it; restarting does.

**Why this reads like a permissions bug and isn't.** `SecretNotFound` is the
same symptom you would get from a missing role assignment, which sends you
looking in the wrong place. The identity already holds Key Vault Secrets User —
confirmed against the live vault. Check the cache before checking RBAC.

---

## Step 3 — Force a run

```bash
KEY=$(az functionapp keys list -g rg-briefing -n func-worker-5ngerafeorjcg --query masterKey -o tsv)
curl -X POST "https://func-worker-5ngerafeorjcg.azurewebsites.net/admin/functions/scheduledRun" \
  -H "x-functions-key: $KEY" -H "Content-Type: application/json" -d '{"input":""}'
```

**Why not wait for the timer.** The next slot could be most of a day away.
Finding out then that something is misconfigured costs a day per iteration.

**Why it doesn't close issue 04.** The ticket asks for a _scheduled_ run. This
proves the code, the secret and the network; it does not prove the timer fires.

---

## Step 4 — Read the proof line

Application Insights → Logs, on `appi-5ngerafeorjcg`:

```kusto
traces
| where timestamp > ago(1h)
| where message has "proof-run"
| project timestamp, message
```

**What good looks like:** `"outcome":"success"` with `"llmCalls":2`. Two calls
is the signal that matters — it means model → tool → model, rather than the
model answering from memory without touching the tool.

**Why a log query rather than an exit code.** The likeliest failure of a daily
job is not running at all, and nothing can report its own absence. One row per
expected slot is the only check that catches silence.

**Cold start, issue 04's third box.** The proof line's own `durationMs` times
`runScheduledTask` alone. Compare it with the invocation's total duration in the
run history: the gap is host startup plus module load. Record the figure. The
design keeps this small deliberately — agents are exported as `createX()`
factories, so no model is constructed at import time. A gap that grows means
work has crept into module scope.

---

## Step 5 — Prove the failure contract survives deployment

```bash
az keyvault secret set --vault-name kv-5ngerafeorjcg --name openai-api-key --value 'sk-deliberately-invalid'
az functionapp restart -g rg-briefing -n func-worker-5ngerafeorjcg
# force a run as in step 3, confirm a Failed invocation and one "outcome":"failure" line, then restore:
az keyvault secret set --vault-name kv-5ngerafeorjcg --name openai-api-key --value "$(pbpaste)"
az functionapp restart -g rg-briefing -n func-worker-5ngerafeorjcg
```

**Why bother.** A monitoring story that has only ever seen success is untested.
This confirms a real failure is visible rather than silent, across the
deployment boundary — the same contract already proven locally.

**Why an invalid value rather than deleting the secret.** Deleting leaves the
reference unresolved in a state that outlives the change; an invalid value fails
where you want it to, in the agent call.

---

## Step 6 — Reconcile the hand-made role assignment

`rbac.bicep` now grants the deployer **Key Vault Secrets Officer**, gated on the
deployer being a `User` so the CI service principal never gains secret access.
But the equivalent assignment already exists on the vault, created by hand with
a random name.

**This will break the next provision if left alone.** Azure rejects a second
assignment for the same principal, role and scope with `RoleAssignmentExists`,
and Bicep names its assignments deterministically via `guid()` — a different
name from the hand-made one. So:

```bash
az role assignment delete \
  --assignee 9f36716f-906f-42fe-8de9-4aaa0efabedf \
  --role "Key Vault Secrets Officer" \
  --scope "/subscriptions/49798f7a-1699-4f48-9133-a4139b6fb828/resourceGroups/rg-briefing/providers/Microsoft.KeyVault/vaults/kv-5ngerafeorjcg"

azd provision   # recreates it, this time owned by the template
```

**Why after the key steps, not before.** Deleting the assignment removes your own
write access to the vault until the provision restores it. Do it once the secret
is settled.

---

## Step 7 — Close issue 04

Wait for one real 09:00 UTC slot — **7:00 pm your time**, since `australiaeast`
is UTC+10 and NCRONTAB has no local time. Then re-run the query from step 4.

- [x] `azd deploy` succeeds from a clean checkout — the CI run proved it, and a
      runner _is_ a clean checkout, so it also proved the `packageManager` fix,
      the esbuild bundle and the `dist/` deploy root
- [ ] A **scheduled** invocation returns a success row — this step
- [ ] Cold-start figure observed and recorded — step 4
- [ ] A deliberately failed run appears as Failed — step 5

Only the second needs the wait. Record the others as you go.

---

## After that

**The seam is `runScheduledTask.ts`.** Replacing the proof task with the real
briefing means changing the body of that one function. The schedule, the
Functions binding, the run-report shape and every resource stay as they are.
That split is the point of the two-module design.

**There is still no test framework.** Deliberate, and in scope for the handoff
spec — but the moment `runScheduledTask` grows real branching, the absence
starts to cost. Choosing and wiring a runner is the natural next piece of work.

**A deprecation warning worth clearing eventually.** `actions/checkout@v4`,
`actions/setup-node@v4` and `pnpm/action-setup@v4` target Node 20 and are being
forced onto Node 24. Nothing is broken; bumping to v5 clears it.

**Turning it all off:**

```bash
azd down --purge
```

`--purge` matters — without it the Key Vault sits soft-deleted for seven days
and blocks a re-provision that wants the same name.
