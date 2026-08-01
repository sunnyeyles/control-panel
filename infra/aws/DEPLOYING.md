# Deploying

Two runbooks. **The briefing worker** — first deploy, verification, rollback —
and, at the end, **giving the dashboard access to user storage** via Vercel
OIDC. They are unrelated deployments that happen to share a bucket and a state
file.

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
| filter @message like /"event":"tick"/ or @message like /"event":"briefing-run"/
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
      **all three** of `briefing-worker/openai-api-key`,
      `briefing-worker/database-url` and `briefing-worker/tavily-api-key`
      (never print any of the values)
- [ ] the function carries `USER_STORAGE_BUCKET_NAME` and
      `USER_STORAGE_ENVIRONMENT`:
      `aws lambda get-function-configuration --function-name briefing-worker --query Environment.Variables`
- [ ] migrations applied: `DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate`
      reports nothing to do on a second run
- [ ] a manual invoke produces one `tick` line; with nothing due that is
      `"due":0` and is a success
- [ ] with a job seeded due, a manual invoke produces one `briefing-run` line
      with `"outcome":"success"`, `"searches"` above zero, and an `objectKey` —
      a non-zero search count is what proves the postings were looked up rather
      than recalled
- [ ] that `objectKey` exists in the bucket, carries the `kind=briefs` tag, and
      has a matching row: `select object_key from artifacts order by created_at desc limit 1`
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

---

# Giving the dashboard access to user storage

The dashboard on Vercel reads and writes uploaded **Documents** in the same
bucket the worker writes briefs to. It gets there by exchanging a Vercel OIDC
token for the `control-panel-vercel-dashboard` role — no access key exists on
this path either.

**The stack is off until you configure it.** `vercel_dashboard` in
`infra/aws/terraform.tfvars` is commented out and defaults to null, which
creates no provider, no role and no attachment. Unconfigured, the dashboard
falls back to the AWS SDK's default credential chain, which is what local
development uses and what production has no answer for — so uploads fail.

## 1. Read the real claim values off a token

Do this **before** applying anything. It is the one part of this change that no
test can check, and getting it wrong produces a failure that names nothing.

Vercel projects run in one of two issuer modes, and which one is a project
setting rather than something derivable:

|        | Issuer (`iss`)                        | Audience (`aud`)                 | Subject (`sub`)                                         |
| ------ | ------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| Team   | `https://oidc.vercel.com/<team-slug>` | `https://vercel.com/<team-slug>` | `owner:<team-slug>:project:<project>:environment:<env>` |
| Global | `https://oidc.vercel.com`             | `https://vercel.com`             | built from opaque `owner_id` / `project_id`             |

Terraform derives the **team-mode** strings from `team_slug`. If the project is
in Global mode those derived values are wrong, and the overrides
(`issuer_url`, `audience`, `subjects`) are how you correct it.

Get the truth from a real token — it is a JWT, so the payload decodes without a
key:

```bash
vercel env pull .env.vercel          # or read VERCEL_OIDC_TOKEN from a deployment
cut -d. -f2 <<<"$VERCEL_OIDC_TOKEN" | base64 -d 2>/dev/null | jq '{iss, aud, sub}'
```

The team **slug** is also not the `orgId` in `.vercel/project.json` — that is an
opaque `team_…` identifier that appears in no claim. Use `vercel teams ls`.

## 2. Create the OIDC provider (bootstrap, by hand)

The deploy role cannot do this: `bootstrap/deploy-iam.tf` grants nothing in the
`iam:*OpenIDConnectProvider*` family, deliberately — a pipeline that can mint a
federated trust for itself is a pipeline that can grant itself anything.

```bash
cd infra/aws/bootstrap
terraform apply \
  -var="state_bucket_name=control-panel-tfstate-<account-id>" \
  -var="github_owner=<owner>" \
  -var="vercel_team_slug=<slug>"
```

Add `-var="vercel_oidc_issuer_url=…"` and `-var="vercel_oidc_audience=…"` if
step 1 showed Global mode.

## 3. Configure and apply the stack

Uncomment `vercel_dashboard` in `infra/aws/terraform.tfvars` and fill in the
slug, plus any overrides. Then let CI apply it (push to `main` touching
`infra/**`), or apply by hand. Read the role ARN out:

```bash
terraform -chdir=infra/aws output -raw vercel_dashboard_role_arn
```

## 4. Set the Vercel project environment

Production scope, four variables:

| Variable                   | Value                                            |
| -------------------------- | ------------------------------------------------ |
| `USER_STORAGE_BUCKET_NAME` | `terraform output -raw user_storage_bucket_name` |
| `USER_STORAGE_ENVIRONMENT` | `prod`                                           |
| `AWS_REGION`               | `ap-southeast-2` — **an override, not a gap**    |
| `AWS_ROLE_ARN`             | the output from step 3                           |

**`AWS_REGION` is the row to be careful with, and not because it is missing.**
Vercel sets it for you, to the region the function happened to execute in. Its
own OIDC documentation says so and warns that under multi-region routing or
failover the value changes between invocations, which "may route your AWS calls
to a region where your resources don't exist". So this row overrides a value
that is already there rather than supplying one that is not.

That distinction is the whole reason to state it, because it inverts the failure
mode `readUserStorageConfig` was built around. That function throws on an unset
variable, loudly and by name — but on Vercel this variable is never unset. Skip
the row and nothing throws: the S3 client is pointed at whichever region the
invocation ran in, and the bucket exists in exactly one. What you get is a
region error against a bucket that looks absent, not a missing-configuration
error naming the setting you forgot.

Then **enable OIDC Federation** in the Vercel project's Settings → Security.
Without it no `VERCEL_OIDC_TOKEN` is injected, `lib/storage.ts` silently takes
its local-development branch, and every upload fails on absent credentials —
with nothing in the error mentioning OIDC.

## Verifying

Upload a small PDF at `/documents`, then:

```bash
aws s3api list-objects-v2 --bucket <bucket> --prefix "prod/<userId>/resumes/"
aws s3api get-object-tagging --bucket <bucket> --key "prod/<userId>/resumes/<id>.pdf"
aws s3api head-object       --bucket <bucket> --key "prod/<userId>/resumes/<id>.pdf"
```

Three things to confirm, because each fails silently:

- The key is `prod/{userId}/resumes/{uuid}.pdf` — `{userId}` is `users.id`, the
  uuid this repo generates, not the Neon Auth id.
- The **tag** is `kind=resumes`. The tag is what the lifecycle rules filter on;
  metadata alone gives the object no retention policy.
- Metadata carries `original-filename` and, if a type was chosen,
  `document-type`.

## The first failure to expect

`AccessDenied` on `sts:AssumeRoleWithWebIdentity`, from a `sub` that does not
match what step 1 established.

**It does not look like a permissions problem in the UI.** The store maps
`AccessDenied` to `StorageUnavailableError`, and the action maps that to
_"Document storage is unavailable. Try again in a moment."_ — which reads as
transient. The diagnosis is in the Vercel function logs, where
`documents: upload failed` carries the underlying SDK error.

Check, in order: OIDC Federation is enabled; `AWS_ROLE_ARN` matches the output;
the role's trust policy `sub` matches the token's `sub` exactly (it is
`StringEquals`, so near enough is not enough); and `AWS_REGION` names the
bucket's region rather than whatever Vercel filled in — "set" is not the test,
since it is always set.
