# Bootstrap

Applied **once, by hand, by a human with admin**, before anything in
`infra/aws/` can be applied at all. It creates the three things that cannot
create themselves:

- the S3 bucket the main root keeps its state in,
- the GitHub OIDC provider,
- the deploy role CI assumes.

State here is a local file, permanently. This root creates the bucket the other
one stores state in, so it cannot store its own state there.

## Running it

```bash
cd infra/aws/bootstrap

terraform init
terraform apply \
  -var="state_bucket_name=control-panel-tfstate-<account-id>" \
  -var="github_owner=<owner>"
```

Get `<account-id>` from `aws sts get-caller-identity --query Account --output text`.

Then set the outputs as **repository variables** — not secrets. The deploy
workflow reads `vars.*`, and a value created as a secret reads back as an empty
string, which fails in a way that looks like the variable was never set:

```bash
gh variable set AWS_REGION           --body "ap-southeast-2"
gh variable set AWS_DEPLOY_ROLE_ARN  --body "$(terraform output -raw deploy_role_arn)"
gh variable set TF_STATE_BUCKET      --body "$(terraform output -raw state_bucket_name)"
gh variable set ALERT_EMAIL          --body "you@example.com"
```

## Then point the main root at the bucket

`infra/aws/backend.tf` is a partial configuration — the bucket is supplied at
init time, so nothing in the repository names a bucket that might not exist:

```bash
cd infra/aws
terraform init -backend-config="bucket=control-panel-tfstate-<account-id>"
```

Keep a local `backend.hcl` (gitignored) so repeat inits are one flag:

```hcl
bucket = "control-panel-tfstate-<account-id>"
```

## The OIDC subject claim will probably not match on the first try

GitHub moved to **immutable subject claims** on 2026-07-15. Repositories created
after that date get a `sub` containing numeric owner and repository IDs:

```
repo:owner@88967314/control-panel@1312572747:ref:refs/heads/main
```

Every example online still shows `repo:owner/name:ref:refs/heads/main`. The
Azure setup hit the same thing from the other side and it cost an afternoon —
see the `AADSTS700213` note in `infra/README.md`.

`github_subject_patterns` therefore defaults to a `StringLike` accepting both
shapes on `main`. If a run still fails to assume the role:

1. Find the `AssumeRoleWithWebIdentity` event in CloudTrail — the failure is
   recorded with the subject that was actually presented.
2. Set `github_subject_patterns` to exactly that value and re-apply.

Tightening from `StringLike` to the observed literal is worth doing, but it is
a follow-up, not a prerequisite.

## What the deploy role deliberately cannot do

It can create, tag and destroy the OpenAI secret. It **cannot read or write the
value** — an explicit `Deny` on `secretsmanager:GetSecretValue` and
`PutSecretValue` that overrides every `Allow`, including any added later by
widening the policy.

This is the Azure property carried over: there, Key Vault Secrets Officer was
granted only when `principalType == 'User'`, so the pipeline could provision the
vault and never read the key.

A consequence worth stating plainly: adding an `aws_secretsmanager_secret_version`
resource will fail in CI. That is the guardrail working. The key is set once, by
a person:

```bash
aws secretsmanager put-secret-value \
  --secret-id briefing-worker/openai-api-key \
  --secret-string "sk-..."
```

The rest of the policy is deliberately coarse — `lambda:*`, `s3:*` and friends
on `*`. A genuinely least-privilege Terraform deployer is discovered by
collecting apply failures rather than predicted, and a half-guessed one fails
during a deployment instead of here. The boundary that matters is the deny.
