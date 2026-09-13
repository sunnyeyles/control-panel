# Deploying

Two runbooks. **The root itself** — first deploy, verification, rollback — and,
after it, **giving the dashboard access to user storage** via Vercel OIDC. The
layout, the one-triple-per-stack rule and the architecture behind them live in
`infra/aws/README.md` and are not restated here.

Worth knowing before the first deploy: **both stacks share this root and
therefore one state file**, which is what lets the dashboard's role attach a
policy the user-storage module publishes in a single graph instead of across a
remote-state lookup. Each stack keeps to its own files.

Two things no stack owns. **The SNS topic and its email subscription** live in
`alerting.tf`, because one topic serves every stack and a per-stack topic means
a per-stack confirmation mail. **The permissions boundary** on every role comes
from `boundary.tf`; the deploy role may only create roles that carry it.

## First deploy

**1. Bootstrap, once, as a human with admin.** See
`bootstrap/README.md` — it creates the state bucket, the GitHub OIDC provider
and the deploy role, and prints the repository variables to set.

**2. Point this root at the state bucket.**

```bash
terraform -chdir=infra/aws init -backend-config="bucket=control-panel-tfstate-<account-id>"
```

**3. Apply.**

```bash
terraform -chdir=infra/aws apply
```

No `-var` flags. `alert_email` and the bucket name live in the committed
`infra/aws/terraform.tfvars`, which Terraform auto-loads — check the bucket name
in it is right for this account before the first apply.

**4. Confirm the SNS subscription.** AWS sends a confirmation mail. Until it is
clicked the topic delivers nothing, and silence will look like health. No stack
raises an alarm today; confirming now is what makes the first one a future
stack adds actually arrive.

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn "$(terraform -chdir=infra/aws output -raw alerts_topic_arn)"
```

`PendingConfirmation` rather than a real subscription ARN means nobody clicked.
Worth re-checking after any change that recreates the topic — the subscription
goes with it, and a fresh mail must be clicked before anything is delivered
again.

## Verifying

Done means all of:

- [ ] `terraform -chdir=infra/aws test` passes (no credentials needed)
- [ ] `terraform apply` clean, and a following `plan` reports no changes
- [ ] the dashboard role carries the boundary:
      `aws iam get-role --role-name control-panel-vercel-dashboard --query Role.PermissionsBoundary`
- [ ] the SNS subscription is confirmed, per step 4
- [ ] an upload at `/documents` lands with the key, tag and metadata described in
      the dashboard runbook's §Verifying below

## Rollback

Deploys are `git push` → CI → `terraform apply`, so a rollback is a revert and
a re-apply:

```bash
git revert <the bad commit> && git push
```

That applies the reverted Terraform in one run, which is the same path that put
the bad version there.

One thing a revert does **not** undo: **anything already written to S3.** The
bucket is versioned, so an overwritten document is recoverable by version ID and
a deleted one sits behind a delete marker — but reverting code does not remove
what a bad deploy wrote.

---

# Giving the dashboard access to user storage

The dashboard on Vercel reads and writes uploaded **Documents** in the
user-storage bucket. It gets there by exchanging a Vercel OIDC token for the
`control-panel-vercel-dashboard` role — no access key exists on this path.

**This stack is configured and on.** `vercel_dashboard` in
`infra/aws/terraform.tfvars` names a `team_slug`, so the role and its
attachment exist. The steps below are the record of how it got there — follow
them when standing up a new account, a second Vercel project, or a changed team
slug, and read step 4 whenever an upload starts failing.

The variable still defaults to null, and null creates no provider, no role and
no attachment. Left that way, the dashboard falls back to the AWS SDK's default
credential chain — which is what local development uses and what production has
no answer for, so uploads fail.

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

Set `vercel_dashboard` in `infra/aws/terraform.tfvars` — the slug, plus any
overrides step 1 turned up. Then let CI apply it (push to `main` touching
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
