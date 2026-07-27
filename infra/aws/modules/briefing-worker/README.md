# `briefing-worker`

The scheduled worker: a Lambda, the schedule that fires it, the secret it reads,
and the alarms that notice when it stops.

```
EventBridge Scheduler ──assumes role──► Lambda (nodejs22.x, arm64)
  cron(0 9 * * ? *) UTC                   │
  flexible window OFF                     ├─► Secrets Manager  (GetSecretValue at cold start)
  retries = 0                             ├─► CloudWatch Logs  (one proof-run JSON line)
                                          └─► api.openai.com   (no VPC)

CloudWatch alarms ──► SNS topic ──► email
  Errors >= 1        (a run failed)
  Invocations < 1    (a run never happened)
```

## What this module does not create

**No IAM role for storage, and no bucket.** Briefs live in the bucket the
`user-storage` module owns. That module creates no roles and this one creates
no buckets, which is what keeps the two from fighting over a shared resource.
The seam is `execution_role_name`: attach the storage module's access policy to
it — the per-(environment, kind) one, `prod:briefs`, rather than the broader
per-environment grant. The worker writes briefs, and authority over everything
else a user has stored is authority it never exercises.

**No `aws_lambda_permission`.** Scheduler assumes `${function_name}-scheduler`
to invoke the function, so permission is expressed once, in `iam.tf`, rather
than split between a role and a resource-based policy that have to agree.

**No secret value.** `aws_secretsmanager_secret` creates an empty shell;
`aws_secretsmanager_secret_version` is deliberately absent so the key never
enters plan output or state. Set it once by hand:

```bash
aws secretsmanager put-secret-value \
  --secret-id briefing-worker/openai-api-key \
  --secret-string "sk-..."
```

**No VPC.** Outbound traffic is `api.openai.com` and AWS APIs only. Putting the
function in a VPC to reach the public internet would need a NAT gateway and buy
nothing.

## Ordering trap

`lambda_zip_path` is read by `filebase64sha256` at **plan** time, not apply
time. The zip must exist before `terraform plan` runs, or the plan fails with a
file-not-found that looks like a Terraform problem and is not:

```bash
pnpm turbo zip --filter=@workspace/briefing-worker   # then plan
```

## One run per slot

Retries are off in two places, because there are two retry layers and the
obvious one only covers half the problem:

- `retry_policy.maximum_retry_attempts = 0` on the schedule target — otherwise
  Scheduler retries 185 times over 24 hours.
- `aws_lambda_function_event_invoke_config.maximum_retry_attempts = 0` —
  Scheduler invokes asynchronously, which brings Lambda's own 2 retries into
  play from a layer the schedule's policy does not reach.

Together they preserve the contract the daily check depends on: exactly one
`proof-run` line per slot, and a failed run waits for tomorrow.
