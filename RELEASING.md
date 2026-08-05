# Releasing

The end-to-end path for shipping a change that carries new Terraform: what to
check before pushing, which of the three secret stores to touch, how the apply
actually happens, and what to look at afterwards.

This is the index. The depth lives elsewhere and is not restated here —
`infra/aws/DEPLOYING.md` for the worker runbook and the Vercel OIDC setup,
`infra/aws/README.md` for the stack layout, `infra/aws/bootstrap/README.md` for
the one-time-by-a-human parts.

## 0. Which secret store are you actually touching

Three, and they are not interchangeable. Most feature deploys touch only the
first.

| Store                   | Holds                                                                                                                                            | Who writes it                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **AWS Secrets Manager** | the worker's runtime secrets — five today                                                                                                        | **a person, by hand.** Terraform creates the shell empty and the deploy role is denied `PutSecretValue` |
| **GitHub**              | three repository **variables**, no secrets: `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`                                               | you, once, from the bootstrap outputs                                                                   |
| **Vercel**              | `USER_STORAGE_BUCKET_NAME`, `USER_STORAGE_ENVIRONMENT`, `AWS_REGION`, `AWS_ROLE_ARN`, `BRIEFING_WORKER_FUNCTION_NAME`, plus the Neon Auth values | you, in project settings                                                                                |

The GitHub three change only when bootstrap is re-applied. They must be
**variables** — `deploy-infra.yml` reads `vars.*`, and a value created as a
secret reads back as an empty string, which fails as though it were never set.

## 1. Before pushing — everything that needs no AWS credentials

```bash
pnpm turbo zip --filter=@workspace/briefing-worker      # build FIRST — plan reads lambda.zip
terraform -chdir=infra/aws fmt -recursive -check -diff
terraform -chdir=infra/aws init -backend=false && terraform -chdir=infra/aws validate
terraform -chdir=infra/aws test
pnpm test
```

`terraform test` is the one that earns its keep, and it is what a pull request
is gated on. If the change adds a stack or an object kind, extend
`infra/aws/tests/` with it — the suite asserts correspondences that nothing else
catches, such as every kind having a lifecycle rule.

Two failure modes that are worth heading off in this step rather than in CI:

- **A new stack that creates an IAM role must pass the permissions boundary,**
  exactly as `briefing-worker.tf` does. The deploy role may only create roles
  carrying it, so forgetting produces an access-denied naming the role on the
  first apply. If the role is not named `briefing-worker-*` or `control-panel-*`,
  add the pattern to `managed_role_arn_patterns` in `bootstrap/variables.tf` and
  re-apply bootstrap by hand.
- **Do not add an `aws_secretsmanager_secret_version` resource.** CI cannot apply
  one; the deny is deliberate. See §2.

A new stack is otherwise one `<stack>.{tf,variables.tf,outputs.tf}` triple and
one line in `terraform.tfvars` — see `infra/aws/README.md`.

## 2. If the feature needs a new secret

Three edits, then one manual put, in that order:

1. `infra/aws/modules/briefing-worker/secrets.tf` — the
   `aws_secretsmanager_secret` shell, and its read grant in `iam.tf`
2. `infra/aws/modules/briefing-worker/main.tf` — the `<NAME>_SECRET_ID`
   environment variable pointing at the ARN
3. `apps/briefing-worker/src/index.ts` — one more `loadSecret(...)` in
   `loadSecrets()`

Then, **immediately after the apply that creates the shell**:

```bash
aws secretsmanager put-secret-value \
  --secret-id briefing-worker/<new-secret> --secret-string "…"
```

`loadSecrets` fetches all of them concurrently at handler init, so **a single
empty shell takes down every invocation** — including ticks with nothing due —
before `runTick` is reached and before any run report is emitted. The error names
no secret, so the first useful question is which one is empty. This has already
happened once, with the Tavily secret: the shell and the reference to it went out
in the same apply and the value never went in behind them.

Rotating an existing secret is the same command and needs no apply.

## 3. Deploying

```bash
git push          # to the HTTPS remote — the ssh origin has no askpass
gh pr create      # a pull request runs `check` only
```

A pull request cannot assume the deploy role — its trust policy names
`ref:refs/heads/main` alone, which is the point rather than a limitation. Merge
to `main` and `deploy-infra.yml` builds the zip, assumes the role by OIDC, plans
and applies. One apply ships the Lambda code and the infrastructure together, so
there is no window in which the function and its schedule disagree.

The workflow is path-scoped: `apps/briefing-worker/**`, `packages/agents-core/**`,
`packages/agents/**`, `packages/agent-tools/**`, `infra/**`, and its own file. A
dashboard-only push does not start it.

**Squash-merge.** GitGuardian scans every commit on a pull request, so a
credential-shaped string removed in a later commit still flags.

### Applying locally instead

The right route when the change should _not_ land on `main` — a temporary or
experimental worker build:

```bash
pnpm turbo zip --filter=@workspace/briefing-worker
AWS_REGION=ap-southeast-2 terraform -chdir=infra/aws init \
  -backend-config="bucket=control-panel-tfstate-<account-id>"
AWS_REGION=ap-southeast-2 terraform -chdir=infra/aws plan -out=tfplan
AWS_REGION=ap-southeast-2 terraform -chdir=infra/aws apply tfplan
```

`AWS_REGION` is needed **for the backend itself**, not only the provider — the S3
backend errors with "Missing region value" before it reaches `providers.tf`. Run
from the repository root; `cd`-ing into `infra/aws` first breaks `-chdir`. No
`-var` flags: `terraform.tfvars` is committed and auto-loaded.

### Deploying a behaviour change without letting it run what is due

```bash
terraform -chdir=infra/aws apply -var="schedule_enabled=false"
# apply migrations, verify by manual invoke, then re-apply without the flag
```

## 4. The other two deploy surfaces

**The database.** Nothing to do: `.github/workflows/migrate.yml` applies
migrations on every push to `main`, and confirms afterwards that production is
level with the repo. It is unfiltered by path on purpose — `migrate deploy`
against an up-to-date database is a no-op, while a path filter that fails to
match is how production silently falls behind.

To apply by hand anyway — a failed run, or a database the workflow does not
know about — use the direct endpoint:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

`DATABASE_URL_UNPOOLED`, not `DATABASE_URL` — the pooled endpoint runs PgBouncer
in transaction mode, which is the wrong endpoint for migrate. Forward-only.

The workflow needs one secret, `NEON_API_KEY`; the project id is committed in
the workflow because it identifies a project rather than granting access to one.
Prior to 2026-08-05 this step was manual, was missed twice, and put `/settings`
into a 500 on a `cover_letter_instructions` table that only ever existed in git.

**A migration that creates a table the dashboard will read has a backfill
between the two, and the order is not interchangeable:**

```
migrate  →  backfill  →  deploy the dashboard
```

Deploying the dashboard first shows every user an empty page — a table the
worker has begun filling but that holds nothing from before the migration.

**Automating the migration removed the gap this ordering used to sit in.** One
push to `main` now applies the migration and hands Vercel the dashboard that
reads it, while the backfill between them is still a person running a command.
So the ordering is no longer a sequence you carry out; it is a constraint on how
the work is merged. Land the schema and the worker on their own, run the
backfill, and merge the dashboard after — the record fills up while nothing
reads it, which is what makes the window harmless rather than merely short.

The one that exists today is the cumulative postings record:

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate   # or let CI do it
DATABASE_URL=… pnpm --filter @workspace/briefing-worker backfill:postings
```

The backfill takes the **pooled** `DATABASE_URL`, unlike the migration above it:
it is ordinary application traffic through `createPrismaClient()`, not a schema
change. It walks every succeeded run oldest-first, prints one
`"event":"backfill-postings"` line saying how many runs it walked, how many it
skipped and how many records it wrote, and is safe to run again — the write it
uses is an upsert that never touches a status a person set. Runs it skips are
ordinary: findings that are absent or unparseable, which is every run predating
the `runs.findings` column.

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

## 5. Verifying

```bash
# every secret holds a value — count versions, never print one
for s in openai-api-key database-url apify-token langfuse-public-key langfuse-secret-key; do
  printf '%-22s ' "$s"
  aws secretsmanager describe-secret --secret-id "briefing-worker/$s" \
    --query 'length(keys(VersionIdsToStages || `{}`))' --output text
done

terraform -chdir=infra/aws plan     # must report no changes
aws lambda get-function-configuration --function-name briefing-worker \
  --query Environment.Variables     # the new SECRET_ID is there
aws lambda invoke --function-name briefing-worker /dev/stdout   # one `tick` line
aws sns list-subscriptions-by-topic \
  --topic-arn "$(terraform -chdir=infra/aws output -raw alerts_topic_arn)"
```

Any `0` from the first loop is an outage in waiting. `LastChangedDate` is not the
check — creating an empty shell sets it too, so a secret with no value at all
reads as freshly changed.

The last command matters when a change recreated the SNS topic: the subscription
goes with it, and until the fresh confirmation mail is clicked, silence looks
like health.

The fuller checklist — the boundary on both roles, tag and key-shape assertions
on what a run wrote, the cold-start baseline, the deliberate failure test — is in
`infra/aws/DEPLOYING.md` §Verifying.

## 6. Rolling back

Deploys are `git push` → CI → `terraform apply`, so a rollback is a revert and a
re-apply:

```bash
git revert <the bad commit> && git push
```

To stop the damage faster than CI can run, disable the schedule as in §3 — that
needs no good build to exist yet.

Two things a revert does not undo. **The secret**, whose value Terraform never
wrote: restore the previous one with
`aws secretsmanager get-secret-value --secret-id … --version-stage AWSPREVIOUS`,
not from a clipboard. And **anything already written to S3**: the bucket is
versioned, so an overwrite is recoverable by version ID and a delete sits behind
a marker, but reverting code does not remove what a bad run produced.

## The three ways this usually bites

- `plan` fails with a file-not-found on `lambda.zip`, which reads like a
  Terraform bug and is a missing build.
- Every tick fails because a new secret shell went out empty.
- The CI apply denies because a new role did not carry the permissions boundary.
