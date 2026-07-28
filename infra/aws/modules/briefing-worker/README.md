# `briefing-worker`

The scheduled worker: a Lambda, the schedule that fires it, the secret it reads,
and the alarms that notice when it stops.

```
EventBridge Scheduler ──assumes role──► Lambda (nodejs22.x, arm64)
  cron(0 9 * * ? *) UTC                   │
  flexible window OFF                     ├─► Secrets Manager  (GetSecretValue at cold start)
  retries = 0                             ├─► CloudWatch Logs  (one proof-run JSON line)
                                          └─► api.openai.com   (no VPC)

CloudWatch alarms ──► alerts_topic_arn (the root's SNS topic)
  Errors >= 1        (a run failed)
  Invocations < 1    (a run never happened — only while the schedule is on)
```

## Required inputs worth reading before use

Both are required and neither has a default, because a default would be silently
wrong rather than obviously missing:

- **`alerts_topic_arn`** — where the alarms publish. This module creates no SNS
  topic and no subscription; one topic serves every stack in the root, and a
  per-stack topic would mean a per-stack confirmation mail to the same person.
- **`function_name`** — also prefixes the schedule, both roles and the secret, so
  every resource here is findable from it. The caller's root declares the
  default; passing `null` to a module input does _not_ fall back to a module
  default, so a default in both places would be dead code here.

`permissions_boundary_arn` is nominally optional and is not in practice. The role
that deploys this module may only create roles carrying that boundary, so leaving
it null produces an access-denied on apply rather than an unbounded role.

## What this module does not create

**No SNS topic, and no email subscription.** Alerting is a property of the
deployment rather than of any one stack, so the root owns the topic and hands
this module its ARN. That is also why the missed-run alarm is gated on
`schedule_enabled`: it treats no invocation as breaching, so leaving it in place
while the worker is deliberately off duty would hold it permanently in ALARM —
and it is the only alarm that catches silence.

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

## If a second scheduled worker appears

This module is not yet a reusable `scheduled-lambda-job`, and deliberately so.
It hardcodes one secret and one environment variable name, so a second worker
cannot use it as-is — but there is one caller today, and generalising now would
mean designing an interface against an imagined second consumer rather than a
real one.

The change is mechanical when the trigger arrives: lift `secrets` to a map input
and the rest of the module already generalises. Do it then, against the two
actual callers.
