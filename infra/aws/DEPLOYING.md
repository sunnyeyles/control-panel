# Deploying the briefing worker

The runbook for the worker: first deploy, verification, and rollback.

> **Housekeeping.** This is a separate file rather than a section of
> `infra/aws/README.md` so the runbook stays skimmable next to that file's
> architecture material. Fold it in if it stops earning the separation.

## Layout

```
infra/aws/
  backend.tf                     partial S3 backend — bucket supplied at init
  terraform.tfvars               committed; the values this deployment applies
  briefing-worker.tf             the module block, and the join to brief storage
  briefing-worker.variables.tf   its one object variable, plus schedule_enabled
  briefing-worker.outputs.tf     its outputs
  alerting.tf  boundary.tf       shared: the SNS topic, the permissions boundary
  providers.tf  versions.tf      shared with the user-storage stack
  modules/briefing-worker/       the worker: lambda, schedule, secret, alarms
  bootstrap/                     state bucket, GitHub OIDC, deploy role, boundary
```

Two stacks share this root and therefore share one state file, which is what
lets the worker's execution role and the bucket policy that references it
resolve in a single graph instead of across a remote-state lookup. Each stack
keeps to its own files: nothing here edits `user-storage.tf` or
`modules/user-storage/`.

Two things the worker no longer owns. **The SNS topic and its email
subscription** live in `alerting.tf`, because one topic serves every stack and a
per-stack topic means a per-stack confirmation mail. **The permissions boundary**
on both its roles comes from `boundary.tf`; the deploy role may only create roles
that carry it.

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
terraform -chdir=infra/aws apply
```

No `-var` flags. `alert_email` and the bucket name live in the committed
`infra/aws/terraform.tfvars`, which Terraform auto-loads — check the bucket name
in it is right for this account before the first apply.

**4. Set the OpenAI key by hand.** Terraform creates the secret empty and can
never write it — that is deliberate, see `bootstrap/README.md`.

```bash
aws secretsmanager put-secret-value \
  --secret-id briefing-worker/openai-api-key \
  --secret-string "sk-..."
```

**Rotate the key while doing this.** The value in use was exposed in plaintext
and has never been rotated since. Issue a new one at the OpenAI dashboard,
revoke the old one there, and put only the new value into Secrets Manager.

**5. Confirm the SNS subscription.** AWS sends a confirmation mail. Until it is
clicked the alarms deliver nothing, and silence will look like health.

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn "$(terraform -chdir=infra/aws output -raw alerts_topic_arn)"
```

`PendingConfirmation` rather than a real subscription ARN means nobody clicked.
Worth re-checking after any change that recreates the topic — the subscription
goes with it, and a fresh mail must be clicked before anything is delivered
again.

## Verifying

```bash
aws lambda invoke --function-name briefing-worker \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

In CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /"event":"tick"/ or @message like /"event":"proof-run"/
| sort @timestamp desc
| limit 40
```

and for the daily health check — count ticks, not runs, since most hours have
nothing due and a run report is only emitted when a job is actually claimed:

```
filter @message like /"event":"tick"/
| parse @message '"failed":*,' as failed
| stats count() as ticks, sum(failed) as failed_runs by bin(1d)
```

Twenty-four ticks a day is healthy. Fewer means the schedule is not firing,
which is the missed-run alarm's job to notice — but this is how to see it.

Done means all of:

- [ ] `terraform -chdir=infra/aws test` passes (no credentials needed)
- [ ] `terraform apply` clean, and a following `plan` reports no changes
- [ ] both roles carry the boundary:
      `aws iam get-role --role-name briefing-worker-execution --query Role.PermissionsBoundary`
- [ ] `aws secretsmanager describe-secret` shows a recent `LastChangedDate` for
      **both** `briefing-worker/openai-api-key` and `briefing-worker/database-url`
      (never print either value)
- [ ] migrations applied: `DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate`
      reports nothing to do on a second run
- [ ] a manual invoke produces one `tick` line; with nothing due that is
      `"due":0` and is a success
- [ ] with a job seeded due, a manual invoke produces one `proof-run` line with
      `"outcome":"success"` and `"llmCalls":2` — two calls is what proves
      model → tool → model rather than the model answering from memory
- [ ] `Init Duration` noted from the `REPORT` line, as the cold-start baseline.
      Expect it to have grown: the bundle now carries `pg`, and a tick pays a
      Neon wake on top
- [ ] `Init Duration` and total duration on an idle tick are both acceptable —
      an hourly tick wakes Neon 24× a day where a daily one woke it once, which
      is a compute-hours line to watch rather than a caching strategy to build
- [ ] the failure contract: set the OpenAI secret to an invalid value, invoke
      with a job due, and confirm exactly one `"outcome":"failure"` line, a
      `tick` line with `"failed":1`, one `Errors` datapoint and an alarm mail —
      then restore with
      `aws secretsmanager get-secret-value --version-stage AWSPREVIOUS`, not from
      the clipboard
- [ ] ticks land on the hour unprompted

## Taking the worker off duty

Verifying a change without letting it run whatever is due:

```bash
terraform -chdir=infra/aws apply -var="schedule_enabled=false"
```

The function stays deployed and manually invocable; only the tick is disabled.
Re-apply without the flag to put it back on duty.

**This is the safe half of the tick cutover.** The worker and its schedule
changed meaning at the same moment — the function became "run what is due" and
the schedule became hourly — and deploying either alone leaves the system
incoherent: an hourly schedule against a worker that ignores the database runs
the proof task 24 times a day, and a daily schedule against the tick caps every
job at one run a day. Deploy both with `schedule_enabled=false`, apply
migrations, verify by manual invoke, then enable.

`schedule_enabled` is the one stack input kept as a flat top-level variable
rather than a field of the `briefing_worker` object, precisely so it can be set
this way — an object field cannot be overridden from the command line without
restating the whole object.

The missed-run alarm is destroyed along with the schedule rather than left to
fire. It treats no invocation as breaching, so leaving it in place would hold it
permanently in ALARM while the worker is deliberately off duty — and it is the
only alarm that catches silence, so teaching anyone to ignore its mail is the one
habit worth avoiding.

## Rollback

Deploys are `git push` → CI → `terraform apply`, so a rollback is a revert and
a re-apply:

```bash
git revert <the bad commit> && git push
```

That rebuilds the zip from the reverted source and applies the reverted
Terraform in one run, which is the same path that put the bad version there.

To get out from under a broken function faster than CI can run, disable the
schedule as above — that stops the damage without needing a good build to exist
yet.

Two things a revert does **not** undo:

- **The secret.** Terraform never writes its value. If a rotation is what broke
  the run, restore the previous one directly:
  `aws secretsmanager get-secret-value --secret-id briefing-worker/openai-api-key --version-stage AWSPREVIOUS`
- **Anything already written to S3.** The bucket is versioned, so an overwritten
  brief is recoverable by version ID and a deleted one sits behind a delete
  marker — but reverting code does not remove what a bad run produced.
