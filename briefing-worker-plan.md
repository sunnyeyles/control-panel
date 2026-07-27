# Briefing worker — close the rename, then prove a real run

> [!WARNING]
>
> ## This plan targets Azure, and we are migrating to AWS Lambda
>
> **Treat everything below as possibly redundant.** It was written against the
> current Azure Functions deployment — Flex Consumption, Key Vault, App Service
> Key Vault references, Application Insights, Bicep, `azd`. A move to AWS Lambda
> replaces essentially all of that: the secret store, the scheduler, the log
> sink, the IaC language and the deploy tool.
>
> Before spending time on any step here, decide whether it still earns its keep:
>
> | Still worth doing regardless                                                                                                                                              | Redundant once Lambda lands                                                                                                                                              |
> | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | **Step 1 — the key rotation.** The exposed key must be replaced wherever it lives. Only the _destination_ changes (Key Vault → Secrets Manager / SSM / a Lambda env var). | **Steps 2, 6** — App Service reference caching and the Key Vault role-assignment reconcile are Azure-shaped problems that vanish with the platform.                      |
> | **Step 0 — the Bicep rename.** Trivially cheap and it closes an already-uncommitted diff. Do it even if the Bicep is deleted next month, so the tree isn't left dirty.    | **Step 7** — closing issue 04 against an Azure timer proves a platform being retired.                                                                                    |
> | **The run-report contract** (`proof-run`, `"llmCalls":2`, throw-on-failure). This is platform-independent and is the thing worth carrying across.                         | **Steps 3, 4, 5 as written** — the mechanics (admin endpoint, KQL, `az functionapp restart`) are Azure-specific, though the _questions_ they answer all recur on Lambda. |
>
> The genuinely portable asset is **`apps/briefing-worker/src/run-scheduled-task.ts`**.
> It has no Azure imports — it is an agent call plus a success contract. The
> Azure coupling is confined to `src/functions/scheduled-run.ts`, which is a
> handful of lines binding a schedule to that function. That split was
> deliberate, and it is what makes a Lambda port small: replace the trigger
> module, keep the task.
>
> Also worth carrying over rather than rediscovering: the verification questions
> in steps 4 and 5 — _did the tool actually run, or did the model answer from
> memory?_ and _is a failure visible rather than silent?_ Those are the parts of
> this document with a life beyond Azure.
>
> **Status:** not committed. Delete this file rather than maintaining it if the
> migration starts in earnest.

---

## Context

`apps/briefing-worker` is deployed to Azure and the CI pipeline is green, but the
worker has **never successfully executed**. Every path was blocked on the OpenAI
key, which had been exposed in plaintext. The key has now been rotated at
platform.openai.com and the new value is on the clipboard, which unblocks the
sequence in `next-steps.md`.

Goal: land the leftover Bicep rename, push the new key into Key Vault, and drive
the worker to a first verified run — a `proof-run` line with
`"outcome":"success"` and `"llmCalls":2` — plus the cold-start figure and a
deliberately-failed run. That ticks three of issue 04's four boxes. The fourth (a
_scheduled_ invocation) needs a real 09:00 UTC slot and is out of scope.

### What was verified live, and where the handoff is now stale

The handoff at `/tmp/briefing-worker-handoff-2026-07-28.md` predates commit
`6264221 Removes camelCase`. Four of its claims no longer hold:

| Handoff said                                                                  | Actually true now                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Large uncommitted rename across worker, `turbo.json`, `package.json`, READMEs | All committed in `6264221`. **Only** the Bicep file + its one reference remain uncommitted — a 2-file diff. |
| `functionapp.zip` sits untracked                                              | No untracked files at all.                                                                                  |
| App setting pinned at `SecretNotFound`                                        | Status is **`Initialized`**, not `SecretNotFound`. Trap #1 as written does not apply.                       |
| Clear `sk-proj-` out of `~/.zsh_history`                                      | `grep` finds no `sk-` strings. Already clean.                                                               |

Still true and confirmed against live Azure:

- The vault secret `openai-api-key` was last updated **2026-07-27T09:52:58Z** — unrotated in the vault.
- The hand-made **Key Vault Secrets Officer** assignment is real and is hand-made: created `09:49:35`, **nine minutes after** the `rbacAssignments` Bicep deployment at `09:40:02`, `createdBy` = the user's own principal. Step 6's `RoleAssignmentExists` trap is genuine.
- `az bicep build --file infra/main.bicep --stdout` exits 0 after the rename. Six warnings, zero errors — pre-existing azd-starter noise.

Two findings that shape the plan:

- **`az functionapp function list` returns empty.** Combined with the
  `Initialized` reference status, this suggests the host has not started /
  triggers are not synced. Step 3's admin endpoint may 404. Contingency below.
- **The `application-insights` az extension will not install** (`Pip failed with
status code 1`), so `az monitor app-insights query` is unavailable. Step 4 is
  planned around the portal instead.

---

## Step 0 — Commit the Bicep rename

The only uncommitted work: `infra/app/storage-PrivateEndpoint.bicep` →
`storage-private-endpoint.bicep` (the last camelCase filename, an azd-starter
leftover) plus its single reference at `infra/main.bicep:226`.

Already verified: `git ls-files | grep -E '[a-z][A-Z]'` returns nothing, and the
Bicep compiles clean. Nothing further to check.

The Bicep _symbol_ stays `storagePrivateEndpoint` — camelCase is idiomatic for
Bicep symbolic names, and this rename was only ever about filenames.

```bash
git add -A && git commit
```

Message in the repo's existing third-person style (`Removes camelCase`, `Grants
the deployer vault access…`): **"Renames the last camelCase Bicep file"**, with
the `Co-Authored-By` trailer.

> **Flag:** recent history commits straight to `main`, so this does the same
> rather than branching.

**Push is safe but optional.** Pushing triggers CI → `azd provision`. That does
_not_ hit the step-6 collision: `keyVaultOfficerRoleAssignment_User`
(`infra/app/rbac.bicep`) is gated on `userIdentityPrincipalType == 'User'`, and
CI's deployer is a service principal, so the assignment is skipped there. The
collision only bites a **local** `azd provision`.

---

## Step 1 — Push the new key into Key Vault

The clipboard is volatile, so this goes first among the Azure actions.

```bash
az keyvault secret set --vault-name kv-5ngerafeorjcg --name openai-api-key \
  --value "$(pbpaste)" --output none
```

`--value "$(pbpaste)"` keeps the literal out of both `~/.zsh_history` and
scrollback; `--output none` stops the response echoing the value back.

Verify **without printing the secret** — compare digests and confirm the
timestamp moved off `2026-07-27T09:52:58Z`:

```bash
az keyvault secret show --vault-name kv-5ngerafeorjcg --name openai-api-key \
  --query value -o tsv | tr -d '\n' | shasum -a 256
pbpaste | tr -d '\n' | shasum -a 256          # must match
az keyvault secret show --vault-name kv-5ngerafeorjcg --name openai-api-key \
  --query attributes.updated -o tsv
```

---

## Step 2 — Restart, then confirm the reference resolves

```bash
az functionapp restart -g rg-briefing -n func-worker-5ngerafeorjcg
```

Then poll the config-reference status until it reads `Resolved` (the exact `az
rest` URI is in `next-steps.md` step 2). App Service caches
`@Microsoft.KeyVault(...)` resolution at app start, so the restart is what
re-reads the vault.

**Current status is `Initialized`, not `SecretNotFound`** — so if this sticks,
the handoff's "it's a stale cache, not RBAC" reasoning is the wrong lens.
`Initialized` more likely means the host has not started at all (Flex
Consumption scales to zero). RBAC is confirmed fine: the app's managed identity
`057a0f12-…` holds Key Vault Secrets User on the vault. Do not go looking at role
assignments.

---

## Step 3 — Force a run through the admin endpoint

Master key + `POST /admin/functions/scheduledRun`, exactly as `next-steps.md`
step 3 has it. Waiting for the timer costs a day per iteration.

The registered name is `scheduledRun` — the string in `app.timer()` at
`apps/briefing-worker/src/functions/scheduled-run.ts:15`, not the filename. The
rename did not change it.

**Contingency for the empty function list.** If this 404s, triggers are not
synced. In order: `az functionapp show` the host state → `GET /admin/functions`
with the master key to see what the host actually has → if genuinely absent,
re-deploy with `azd deploy` (build + `turbo zip` are already wired:
`pnpm turbo zip --filter=@workspace/briefing-worker`).

---

## Step 4 — Read the proof line and record cold start

`traces | where message has "proof-run"` on `appi-5ngerafeorjcg`.

**Good looks like** `"outcome":"success"` with `"llmCalls":2`. Two calls is the
signal that matters — model → tool → model, rather than the model answering from
memory. That is enforced structurally in `runScheduledTask`
(`apps/briefing-worker/src/run-scheduled-task.ts`): `assertSucceeded` throws
unless the transcript ends on an `AIMessage` with no pending tool calls _and_
`countTimeToolResults` saw a non-error `ToolMessage`.

**Because the az extension is broken**, get the line via the Kudu/host log
stream (`az webapp log tail`) or the invocation detail, and run the KQL from
`next-steps.md` step 4 in the portal for the authoritative check.

**Cold start** (issue 04's third box): the proof line's own `durationMs` times
`runScheduledTask` alone. Subtract it from the invocation's total duration in the
run history — the gap is host startup plus module load. Record the figure. It
should be small by design: agents are exported as `createX()` factories, so no
model is constructed at import time. A gap that grows means work has crept into
module scope.

---

## Step 5 — Prove the failure contract survives deployment

Set the secret to `sk-deliberately-invalid`, restart, force a run, confirm a
**Failed** invocation and exactly one `"outcome":"failure"` line, then restore.

An invalid value rather than a deletion, deliberately: deleting leaves the
reference unresolved in a state that outlives the change, whereas an invalid
value fails where you want it to — inside the agent call.

**Restore from Key Vault's version history, not from the clipboard.**
`next-steps.md` reaches for `pbpaste` a second time, but by then you may well
have copied something else, and a failed restore leaves the worker broken. Key
Vault retains the prior version, so:

```bash
# capture the good version id BEFORE breaking it
GOOD=$(az keyvault secret list-versions --vault-name kv-5ngerafeorjcg \
  --name openai-api-key --query "[?attributes.enabled].id | [0]" -o tsv)

# ... break, test, then restore, never printing the value:
az keyvault secret set --vault-name kv-5ngerafeorjcg --name openai-api-key \
  --value "$(az keyvault secret show --id "$GOOD" --query value -o tsv)" --output none
```

Then restart again and re-confirm one `"outcome":"success"` line, so the worker
is not left holding a bad key.

---

## Verification — what "done" means

- [ ] `git log -1` shows the rename commit; `git status` clean; `az bicep build --file infra/main.bicep --stdout` still exits 0
- [ ] Vault secret's `attributes.updated` is today, and its SHA-256 matches the clipboard's
- [ ] Config reference reports `Resolved`
- [ ] One `proof-run` trace with `"outcome":"success"` and `"llmCalls":2`
- [ ] Cold-start figure computed and written into `next-steps.md` step 7's checklist
- [ ] One Failed invocation with `"outcome":"failure"`, then a clean success after restore
- [ ] `next-steps.md` updated: tick boxes 1, 3 and 4 of issue 04; note the `Initialized`-vs-`SecretNotFound` correction in step 2

## Deliberately out of scope

- **Step 6** (delete the hand-made role assignment, `azd provision`) — the trap is confirmed real, but it removes your own vault write access until the provision restores it, so it belongs after the key work has settled.
- **Step 7** — needs a real 09:00 UTC slot, which is 7:00 pm local (`australiaeast`, UTC+10).
- **Replacing the proof task** with the real briefing. The seam is the body of `runScheduledTask`; nothing else moves.
- **A test framework.** There is none in this repo — no runner, no `test` task in `turbo.json`. Do not invent test commands. Wiring one up is its own effort.

## Risks

- **Clipboard volatility.** Step 1 runs first for this reason, and step 5 restores from vault version history rather than re-reading the clipboard.
- **The empty function list** is the most likely place this stalls. Step 3's contingency covers it; worst case it costs an `azd deploy`.
- **Step 5 deliberately breaks production briefly.** Between the invalid set and the restore, the worker cannot run. If the 09:00 UTC slot falls in that window the scheduled run fails for real.
- **The AWS Lambda migration may overtake all of this.** See the warning at the top.
