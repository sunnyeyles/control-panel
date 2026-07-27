# Deploying the briefing worker

The runbook for the AWS stack: first deploy, verification, cutover from Azure,
and rollback.

> **Housekeeping.** This is a separate file rather than a section of
> `infra/aws/README.md` because that file is being written on another branch at
> the same time, and two branches editing one README is a merge conflict for no
> reason. Fold it in once both have landed.

## Layout

```
infra/aws/
  backend.tf                     partial S3 backend — bucket supplied at init
  briefing-worker.tf             the module block, and the join to brief storage
  briefing-worker.variables.tf   its variables
  briefing-worker.outputs.tf     its outputs
  providers.tf  versions.tf      shared with the user-storage stack
  modules/briefing-worker/       the worker: lambda, schedule, secret, alarms
  bootstrap/                     state bucket, GitHub OIDC, deploy role
```

Two stacks share this root and therefore share one state file, which is what
lets the worker's execution role and the bucket policy that references it
resolve in a single graph instead of across a remote-state lookup. Each stack
keeps to its own files: nothing here edits `main.tf` or `modules/user-storage/`.

## First deploy

**1. Bootstrap, once, as a human with admin.** See
`bootstrap/README.md` — it creates the state bucket, the GitHub OIDC provider
and the deploy role, and prints the repository variables to set.

**2. Point this root at the state bucket.**

```bash
terraform -chdir=infra/aws init -backend-config="bucket=control-panel-tfstate-<account-id>"
```

**3. Build before planning.** `filebase64sha256` reads `lambda.zip` at _plan_
time, so a plan on an unbuilt tree fails with a file-not-found that reads like a
Terraform bug.

```bash
pnpm turbo zip --filter=@workspace/briefing-worker
terraform -chdir=infra/aws apply -var="alert_email=you@example.com"
```

**4. Set the OpenAI key by hand.** Terraform creates the secret empty and can
never write it — that is deliberate, see `bootstrap/README.md`.

```bash
aws secretsmanager put-secret-value \
  --secret-id briefing-worker/openai-api-key \
  --secret-string "sk-..."
```

**Rotate the key while doing this.** The current value was exposed in plaintext
and has still not been rotated in Key Vault. The new value should exist only in
Secrets Manager.

**5. Confirm the SNS subscription.** AWS sends a confirmation mail. Until it is
clicked the alarms deliver nothing, and silence will look like health.

## Verifying

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

In CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /"event":"proof-run"/
| sort @timestamp desc
| limit 20
```

and for the daily health check:

```
filter @message like /"event":"proof-run"/
| parse @message '"outcome":"*"' as outcome
| stats count() by outcome, bin(1d)
```

Done means all of:

- [ ] `terraform apply` clean, and a following `plan` reports no changes
- [ ] `aws secretsmanager describe-secret` shows a recent `LastChangedDate`
      (never print the value)
- [ ] a manual invoke produces one `proof-run` line with `"outcome":"success"`
      and `"llmCalls":2` — two calls is what proves model → tool → model rather
      than the model answering from memory
- [ ] `Init Duration` noted from the `REPORT` line, as the cold-start baseline
- [ ] the failure contract: set the secret to an invalid value, invoke, and
      confirm exactly one `"outcome":"failure"` line, one `Errors` datapoint and
      an alarm mail — then restore with
      `aws secretsmanager get-secret-value --version-stage AWSPREVIOUS`, not from
      the clipboard
- [ ] one scheduled run lands at 09:00 UTC unprompted

## Cutover

Both platforms have a live daily timer between the first AWS deploy and this
step, so **the task runs twice a day**. That is harmless while the task is the
proof task, which writes nothing. It stops being harmless the moment the brief
storage work lands — two schedules would write every brief twice.

Two ways to hold that line, and the first is better while AWS is unproven:

```bash
# keep AWS deployed but off duty
terraform -chdir=infra/aws apply -var="schedule_enabled=false"

# or, once AWS is verified: stop Azure, do not delete it
az functionapp stop --name <function-app> --resource-group rg-briefing
```

**Stopping Azure is what makes the duplicate go away while keeping rollback
cheap.** Until the Azure resource group is deleted, rollback is
`az functionapp start` plus a `git revert` — nothing on AWS needs undoing.

## Decommissioning Azure

Only after AWS has run unattended for a settling period. Each of these is
recoverable from git history, but the Key Vault secret is not: soft-delete
retention is 7 days, after which the value must come from the OpenAI dashboard.

- [ ] delete `infra/main.bicep`, `infra/main.parameters.json`,
      `infra/abbreviations.json`, `infra/app/` and `infra/README.md`
- [ ] delete `azure.yaml`
- [ ] drop `local.settings.json`, `functionapp.zip` and `.azure/` from
      `.gitignore`
- [ ] remove `packageManager` from `apps/briefing-worker/package.json` if
      nothing else needs it — it was there for azd's package-manager detection
- [ ] `az group delete --name rg-briefing`
- [ ] delete `briefing-worker-plan.md` at the repo root (untracked; its own
      banner says to)

## Rollback

Before the Azure app is stopped, there is nothing to roll back — both run.

After stopping and before deleting: `az functionapp start`, then revert the
branch if the application code also needs to go back.

After deleting the resource group: `git revert`, then
`azd provision && azd deploy worker`, then re-set the Key Vault secret by hand.

One drift to know about: a hand-made Key Vault Secrets Officer assignment
collides with the Bicep `guid()`-named one on the next local `azd provision`.
It only matters on this path.
