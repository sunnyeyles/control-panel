# Bootstrap

Applied **once, by hand, by a human with admin**, before anything in
`infra/aws/` can be applied at all. It creates the four things that cannot
create themselves:

- the S3 bucket the main root keeps its state in,
- the GitHub OIDC provider,
- the deploy role CI assumes, and its five permission policies,
- the **permissions boundary** every role that role creates must carry.

```
bootstrap/
  state.tf             the state bucket
  oidc.tf              GitHub OIDC provider + the deploy role itself
  boundary.tf          the ceiling on every role CI creates — read this first
  deploy-policies.tf   state / compute / storage / secrets, and the split rationale
  deploy-iam.tf        the IAM half, with the conditions that make the boundary stick
```

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
```

Three, and only three. `ALERT_EMAIL` and `USER_STORAGE_BUCKET_NAME` used to be
here and are not any more — that configuration lives in the committed
`infra/aws/terraform.tfvars`, so the values CI applies are the values in the
diff rather than repository variables that can change without a commit.

**Set the bucket name in `infra/aws/terraform.tfvars` before the first apply.**
It is globally unique and account-specific, and once the bucket exists changing
it means creating a new empty one and abandoning the old one's contents.

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

Every example online still shows `repo:owner/name:ref:refs/heads/main`, so the
first failure looks like a permissions problem and is not one.

`github_subject_patterns` therefore defaults to a `StringLike` accepting both
shapes on `main`. If a run still fails to assume the role:

1. Find the `AssumeRoleWithWebIdentity` event in CloudTrail — the failure is
   recorded with the subject that was actually presented.
2. Set `github_subject_patterns` to exactly that value and re-apply.

Tightening from `StringLike` to the observed literal is worth doing, but it is
a follow-up, not a prerequisite.

## What the deploy role deliberately cannot do

**It cannot read or write a secret's value.** An explicit `Deny` on
`secretsmanager:GetSecretValue` and `PutSecretValue` overrides every `Allow`,
including any added later by widening one of the other four policies. It can
create, tag and destroy the secret container; provisioning a secret and reading
one are different jobs, and CI has only the first.

A consequence worth stating plainly: adding an `aws_secretsmanager_secret_version`
resource will fail in CI. That is the guardrail working. The key is set once, by
a person:

```bash
aws secretsmanager put-secret-value \
  --secret-id briefing-worker/openai-api-key \
  --secret-string "sk-..."
```

**It cannot create a role that escapes the boundary.** `iam:CreateRole`,
`iam:PutRolePolicy` and `iam:AttachRolePolicy` are each conditioned on
`iam:PermissionsBoundary` equalling `control-panel-deploy-boundary`, attaching is
additionally restricted to this project's own policies by `iam:PolicyARN`, and
`iam:DeleteRolePermissionsBoundary` is denied outright. `iam:PassRole` is scoped
to project role ARNs rather than `*`.

Without those, the combination of create-a-role, attach-a-policy and pass-a-role
is administrator: create a role, attach `AdministratorAccess`, give it to a
Lambda, invoke the Lambda. Anything that can push to `main` could do it. See
`boundary.tf` for the full reasoning.

The rest of the policy set is deliberately coarse — `lambda:*`, `s3:*` and
friends on `*`. A genuinely least-privilege Terraform deployer is discovered by
collecting apply failures rather than predicted, and a half-guessed one fails
during a deployment instead of here. The parts that are _not_ coarse are the IAM
conditions and the two denies.

## Introducing the boundary to an account that already has roles

**Only relevant if `infra/aws` has already been applied at least once.** On a
fresh account, apply this root as written and skip to the next section.

The naive order deadlocks. Tightening this root first means the next CI apply
cannot add a boundary to roles that lack one, because the conditions reject the
call. Adding the boundary in `infra/aws` first means CI does not yet hold
`iam:PutRolePermissionsBoundary`. So:

1. **Apply this root with the conditions removed** — create the boundary policy
   and grant `iam:PutRolePermissionsBoundary` unconditionally. Comment out the
   four `condition` blocks in `deploy-iam.tf` for this step only.
2. **Merge the `infra/aws` change** so CI applies the boundary onto the existing
   roles. Confirm with
   `aws iam get-role --role-name briefing-worker-execution --query Role.PermissionsBoundary`.
3. **Apply this root again, as written** — conditions restored.

Verify by pushing a no-op commit to `main` and watching the apply succeed. That
is the real test that the conditions did not lock the deploy role out of its own
resources.

## A note on this root's own state

`terraform.tfstate` here is a local file, and `.gitignore` covers `*.tfstate`, so
it cannot be committed. Today that means it lives on exactly one laptop, and
losing it means importing every resource in this root to regain control of the
role CI depends on.

The chicken-and-egg is only real at creation time. Once the state bucket exists,
this root can move into it:

```bash
cd infra/aws/bootstrap
# add a backend "s3" block with key = "bootstrap/terraform.tfstate"
terraform init -migrate-state -backend-config="bucket=control-panel-tfstate-<account-id>"
```

Recommended, and deliberately left as a step someone takes on purpose rather than
something done here — migrating state is not a thing to discover mid-apply.
