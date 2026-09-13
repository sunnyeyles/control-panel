# Releasing

The end-to-end path for shipping a change: what to check before pushing, which
of the two configuration stores to touch, how the apply actually happens, and
what to look at afterwards.

Two things ship from this repository. **The dashboard** deploys to Vercel from
git on its own. **The AWS infrastructure** — the user-storage bucket, the
dashboard's OIDC role into it, and the alerting topic — is applied by
`.github/workflows/deploy-infra.yml`. Most of this file is about the second,
because it is the one with steps.

This is the index. The depth lives elsewhere and is not restated here —
`infra/aws/DEPLOYING.md` for the first apply and the Vercel OIDC setup,
`infra/aws/README.md` for the stack layout, `infra/aws/bootstrap/README.md` for
the one-time-by-a-human parts.

## 0. Which configuration store are you actually touching

Two, and they are not interchangeable.

| Store      | Holds                                                                                                                                                                    | Who writes it                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **GitHub** | three repository **variables**, no secrets: `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`                                                                       | you, once, from the bootstrap outputs |
| **Vercel** | `USER_STORAGE_BUCKET_NAME`, `USER_STORAGE_ENVIRONMENT`, `AWS_REGION`, `AWS_ROLE_ARN`, the model, search and Langfuse keys the Assistant reads, plus the Neon Auth values | you, in project settings              |

Nothing deployed reads AWS Secrets Manager any more. The deploy role is still
denied `GetSecretValue` and `PutSecretValue` — see
`infra/aws/bootstrap/README.md` — so a runtime secret added to Terraform later
is still an empty shell that a person fills by hand, immediately after the apply
that creates it.

The GitHub three change only when bootstrap is re-applied. They must be
**variables** — `deploy-infra.yml` reads `vars.*`, and a value created as a
secret reads back as an empty string, which fails as though it were never set.

## 1. Before pushing — everything that needs no AWS credentials

```bash
terraform -chdir=infra/aws fmt -recursive -check -diff
terraform -chdir=infra/aws init -backend=false && terraform -chdir=infra/aws validate
terraform -chdir=infra/aws test
pnpm test
```

`terraform test` is the one that earns its keep, and it is what a pull request
is gated on. If the change adds a stack or an object kind, extend
`infra/aws/tests/` with it — the suite asserts correspondences that nothing else
catches, such as every kind having a lifecycle rule and the dashboard holding
exactly the storage kinds it is meant to.

Two failure modes that are worth heading off in this step rather than in CI:

- **A new stack that creates an IAM role must pass the permissions boundary,**
  exactly as `vercel-dashboard.tf` does. The deploy role may only create roles
  carrying it, so forgetting produces an access-denied naming the role on the
  first apply. If the role is not named `control-panel-*`, check
  `managed_role_arn_patterns` in `bootstrap/variables.tf`, add a pattern if none
  matches, and re-apply bootstrap by hand.
- **Do not add an `aws_secretsmanager_secret_version` resource.** CI cannot apply
  one; the deny is deliberate. See §0.

A new stack is otherwise one `<stack>.{tf,variables.tf,outputs.tf}` triple and
one line in `terraform.tfvars` — see `infra/aws/README.md`.

## 2. Deploying

```bash
git push          # to the HTTPS remote — the ssh origin has no askpass
gh pr create      # a pull request runs `check` only
```

A pull request cannot assume the deploy role — its trust policy names
`ref:refs/heads/main` alone, which is the point rather than a limitation. Merge
to `main` and `deploy-infra.yml` assumes the role by OIDC, plans and applies.

The workflow is path-scoped to `infra/**` and its own file. A dashboard-only
push does not start it, and nothing it applies is built from application code,
so there is no package list to keep in step with it.

**Squash-merge.** GitGuardian scans every commit on a pull request, so a
credential-shaped string removed in a later commit still flags.

### Applying locally instead

The right route when the change should _not_ land on `main` yet — trying it
against the real account before merging:

```bash
AWS_REGION=ap-southeast-2 terraform -chdir=infra/aws init \
  -backend-config="bucket=control-panel-tfstate-<account-id>"
AWS_REGION=ap-southeast-2 terraform -chdir=infra/aws plan -out=tfplan
AWS_REGION=ap-southeast-2 terraform -chdir=infra/aws apply tfplan
```

`AWS_REGION` is needed **for the backend itself**, not only the provider — the S3
backend errors with "Missing region value" before it reaches `providers.tf`. Run
from the repository root; `cd`-ing into `infra/aws` first breaks `-chdir`. No
`-var` flags: `terraform.tfvars` is committed and auto-loaded.

A local apply is still an apply to production state. The next push to `main`
touching `infra/**` applies whatever is on `main`, so a change tried this way
that is never merged is reverted by the next unrelated infra change.

## 3. The other two deploy surfaces

**The database.** There is no database. The Neon project was deleted on
2026-08-15 and `.github/workflows/migrate.yml` went with it, so nothing applies
migrations on a push to `main` any more.

It used to, on every push, unfiltered by path on purpose — `migrate deploy`
against an up-to-date database is a no-op, while a path filter that fails to
match is how production silently falls behind. Worth restoring in that shape if
a replacement database ever lands. Before 2026-08-05 the step was manual, was
missed twice, and put `/settings` into a 500 on a table that only ever existed
in git.

To apply by hand anyway, use the direct endpoint:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

`DATABASE_URL_UNPOOLED`, not `DATABASE_URL` — the pooled endpoint runs PgBouncer
in transaction mode, which is the wrong endpoint for migrate. Forward-only.

A migration that creates something the dashboard reads lands **before** the
dashboard that reads it, and anything that has to fill it runs in between.
Deploying the dashboard first shows every user an empty page. If migrate-on-push
is ever restored, one push to `main` will both migrate and hand Vercel the new
dashboard, so that ordering becomes a constraint on how the work is merged
rather than a sequence to carry out: land the schema on its own, fill it, then
merge the dashboard.

**The dashboard.** Vercel deploys it from git on its own; nothing here is needed
unless its environment changed. If it did, set the value in the project's
Production scope and **redeploy** — Vercel does not re-inject into a running
deployment. Two things to be careful with, both covered in
`infra/aws/DEPLOYING.md`:

- `AWS_REGION` must be set explicitly. Vercel always sets it, to whichever region
  the invocation happened to run in, so a wrong value never throws — it produces
  a region error against a bucket that looks absent.
- OIDC Federation must be enabled in Settings → Security, or no
  `VERCEL_OIDC_TOKEN` is injected, `lib/storage.ts` silently takes its
  local-development branch, and every upload fails on absent credentials with
  nothing mentioning OIDC.

## 4. Verifying

```bash
terraform -chdir=infra/aws plan     # must report no changes
aws iam get-role --role-name control-panel-vercel-dashboard \
  --query Role.PermissionsBoundary  # the boundary is attached
aws sns list-subscriptions-by-topic \
  --topic-arn "$(terraform -chdir=infra/aws output -raw alerts_topic_arn)"
```

The last command matters when a change recreated the SNS topic: the subscription
goes with it, and until the fresh confirmation mail is clicked, silence looks
like health.

The dashboard's half — uploading a document and checking the key, tag and
metadata it landed with — is in `infra/aws/DEPLOYING.md` §Verifying.

## 5. Rolling back

Deploys are `git push` → CI → `terraform apply`, so a rollback is a revert and a
re-apply:

```bash
git revert <the bad commit> && git push
```

One thing a revert does not undo: **anything already written to S3**. The bucket
is versioned, so an overwrite is recoverable by version ID and a delete sits
behind a marker, but reverting code does not remove what a bad deploy wrote.

## The three ways this usually bites

- The CI apply denies because a new role did not carry the permissions boundary.
- Uploads fail as "storage unavailable" because OIDC Federation is off or
  `AWS_REGION` was left as Vercel set it — `infra/aws/DEPLOYING.md` §The first
  failure to expect.
- A change recreated the SNS topic, nobody clicked the fresh confirmation mail,
  and alarms go nowhere.
