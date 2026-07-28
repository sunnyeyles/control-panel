# Handoff — AWS infrastructure provisioning

Written 2026-07-29. Covers the session that took this project from "CI has never
successfully deployed" to "CI deploys end to end", and what is still outstanding.

This file deliberately does **not** restate architecture. Read these first:

| For                                       | Read                            |
| ----------------------------------------- | ------------------------------- |
| Repo layout, conventions, agent stack     | `CLAUDE.md`                     |
| What the deploy role may and may not do   | `infra/aws/bootstrap/README.md` |
| Runbook, verification checklist, rollback | `infra/aws/DEPLOYING.md`        |
| Stack/module structure                    | `infra/aws/README.md`           |
| Domain vocabulary                         | `CONTEXT.md`                    |

---

## Where things stand

CI provisioning works. A push to `main` touching `infra/**` or the worker builds
the bundle, assumes a role via GitHub OIDC, and runs `terraform apply`. No
long-lived AWS credentials exist anywhere.

**Deployed and live:**

- `briefing-worker` Lambda (`nodejs22.x`)
- `briefing-worker-daily` schedule — **ENABLED**, `cron(0 * * * ? *)` UTC, i.e.
  hourly despite the resource name (stale name from before the tick cutover)
- Alarms `briefing-worker-errors`, `briefing-worker-not-invoked`
- Secrets `briefing-worker/openai-api-key` and `briefing-worker/database-url`,
  both holding values
- Buckets `control-panel-tfstate-…` and `control-panel-user-storage-…`
- Both worker IAM roles, each carrying `control-panel-deploy-boundary`

**Terraform state** — both roots now in S3: `bootstrap/terraform.tfstate` and
`briefing-worker/terraform.tfstate`. Neither is laptop-only any more.

**Merged this session:** PRs #51–#55. Read the PR bodies for reasoning; each one
explains a defect that only a live apply could surface.

---

## Next steps, in priority order

1. **Apply database migrations. This has a clock on it.** The hourly schedule is
   live and every tick queries a `jobs` table that does not exist yet, so it
   fails and trips the errors alarm.

   ```bash
   cd <repo root>
   ( set -a; . ./.env.local; set +a; pnpm --filter @workspace/db migrate )
   ```

   `.env.local` already holds a correct `DATABASE_URL_UNPOOLED`. Run it twice —
   "nothing to do" on the second run is the success condition. If you would
   rather stop the failing ticks first:
   `terraform -chdir=infra/aws apply -var="schedule_enabled=false"`.

2. **Confirm the SNS subscription.** It is still `PendingConfirmation`, so no
   alarm delivers anything and silence will look like health. AWS emailed the
   address in `infra/aws/terraform.tfvars`.

3. **Smoke test** once migrations are in — see the checklist in
   `infra/aws/DEPLOYING.md`. Expect one `tick` line with `"due":0`.

4. **Merge the in-flight worker branch, then set its Tavily secret.** That work
   adds a third secret, `briefing-worker/tavily-api-key`. Terraform creates it
   empty; a run fails without a value. It passes `fmt`/`validate`/`test`
   locally (12 tests) as of this writing.

5. **Optional, worth a thought:** the account below is an AWS Organization
   _management_ account, which AWS advises against running workloads in (service
   control policies cannot constrain it). This was raised and the user chose it
   deliberately. A dormant empty member account exists if that is ever revisited.

---

## Environment facts a fresh agent will need

- **Account:** `650694420748` (org management account, org `o-owiukqfuu9`).
  Region `ap-southeast-2`.
- **Admin access:** IAM Identity Center. Local profile `admin` in
  `~/.aws/config` (sso-session `infra-init`). Refresh with
  `aws sso login --profile admin`. Everything below assumes `AWS_PROFILE=admin`.
- **A second account `990008009813` exists, empty and dormant** — created during
  this session before the target account was settled. Not in use. Closing it
  costs a 90-day suspension and burns its email alias, so it was left alone.
- **`git push` over SSH fails** on this machine (no askpass). Push to the HTTPS
  remote URL instead.
- **The pre-commit hook fails in a fresh worktree** because `node_modules` is
  absent, so `lint-staged` is missing. For changes the hook would not cover
  anyway (Terraform, Markdown), `--no-verify` is reasonable — but run the
  relevant `terraform fmt`/`validate`/`test` by hand instead.

---

## Provisioning from scratch — the ordering that matters

The full detail is in `infra/aws/bootstrap/README.md`. What that file cannot
tell you is the **dependency order**, which is where this session lost the most
time:

```
admin credentials
  → terraform apply in infra/aws/bootstrap/   (by hand; creates state bucket,
                                               OIDC provider, deploy role)
  → gh variable set AWS_REGION / AWS_DEPLOY_ROLE_ARN / TF_STATE_BUCKET
  → push to main → CI terraform apply → empty secrets now exist
  → put-secret-value by hand for each secret
```

Three traps in that chain:

- **`bootstrap/` is applied by hand and is not in CI's path.** Merging a PR that
  changes it deploys nothing. Every bootstrap change needs a local
  `terraform -chdir=infra/aws/bootstrap apply` afterwards. A merged-but-unapplied
  bootstrap change caused two failed CI runs in this session.
- **Check the account ID before the first apply.** `terraform.tfvars` embeds it
  in a globally unique bucket name, and the bucket carries `prevent_destroy`.
- **The credential-free checks cannot catch IAM gaps.** `terraform validate`
  does not resolve data sources and `terraform test` mocks the provider, so
  missing permissions surface only on a real apply. Two did (see #52, #53).
  Expect this class of failure on any new stack, and read it as the design
  working — `bootstrap/README.md` says least privilege is discovered by
  collecting apply failures, not predicted.

### If a plan says a secret must be replaced

Terraform marks a resource **tainted** when it is created but the post-create
read fails. A tainted resource plans as destroy-then-create, which
`prevent_destroy` refuses — correctly, since replacing a secret deletes its
value and locks the name for a 7-day recovery window. Fix by clearing the flag,
not by relaxing `prevent_destroy`:

```bash
terraform -chdir=infra/aws init \
  -backend-config="bucket=<state bucket>" -backend-config="region=ap-southeast-2"
terraform -chdir=infra/aws untaint 'module.briefing_worker.aws_secretsmanager_secret.<name>'
```

`untaint` only edits state; it does not touch AWS.

---

## Adding a variable

**Decide first: is the value secret?** Anything in the Lambda's `environment`
map appears in plan output, in state, and on the function's configuration page
in the console. That is why `OPENAI_API_KEY`, `DATABASE_URL` and
`TAVILY_API_KEY` are absent from it — only their ARNs are there.

### A secret — four touchpoints, then one manual step

1. `infra/aws/modules/briefing-worker/secrets.tf` — add an
   `aws_secretsmanager_secret`. **Never add an `aws_secretsmanager_secret_version`**;
   the deploy role has an explicit `Deny` on `PutSecretValue`, so it fails CI by
   design.
2. `infra/aws/modules/briefing-worker/main.tf` — add
   `FOO_SECRET_ID = aws_secretsmanager_secret.foo.arn` to the `environment` map.
3. `infra/aws/modules/briefing-worker/iam.tf` — add the ARN to
   `data.aws_iam_policy_document.read_secrets`, or the function gets AccessDenied
   at runtime.
4. `apps/briefing-worker/src/index.ts` — add a `loadSecret(...)` call inside
   `loadSecrets()`.

Then merge, let CI create the empty secret, and set the value by hand:

```bash
read -rs "KEY?value: "
aws secretsmanager put-secret-value --secret-id briefing-worker/<name> --secret-string "$KEY"
unset KEY
```

`read -rs` keeps the value out of shell history and echoes nothing. Verify with
`describe-secret` (check `LastChangedDate`) rather than `get-secret-value`,
which prints the value into scrollback.

Rotation is the same command — it creates a new version and demotes the old one
to `AWSPREVIOUS`, which is the rollback path. Terraform does not track values,
so rotation is never a deploy and never shows as drift.

### A non-secret — one touchpoint

Add the key directly to the `environment` map in
`infra/aws/modules/briefing-worker/main.tf`. To make it configurable, thread it
through `variables.tf` → the module call in `infra/aws/briefing-worker.tf` →
`infra/aws/terraform.tfvars`, as `USER_STORAGE_BUCKET_NAME` already is.

`AWS_REGION` needs no entry — the Lambda runtime supplies it.

### Not AWS at all

The dashboard is a separate deployment. Its variables (`NEON_AUTH_*`,
`AUTH_ALLOWED_EMAILS`, `DATABASE_URL`) come from `neon env pull` into a
git-ignored `.env.local`, and from the hosting provider in production. Nothing
in Secrets Manager serves the Next.js app. `NEON_AUTH_COOKIE_SECRET` is ours to
generate, not Neon's to supply — see `CLAUDE.md`.

---

## Suggested skills

- **`diagnosing-bugs`** — for the next CI failure. The pattern that recurred all
  session: read the actual error principal and action, check live AWS state
  before theorising, and distinguish a permissions gap from an expired
  credential (AWS names which it is).
- **`code-review`** — before merging the in-flight worker branch, which touches
  the module, the tests and the worker entry point together.
- **`tdd`** — if extending `@workspace/db` or `@workspace/user-storage`; both
  have real suites, and `stores.test.ts` silently skips without
  `DATABASE_URL_UNPOOLED`.
- **`research`** — for Next.js 16 or LangChain questions. `.mcp.json` registers
  LangChain docs servers, and `node_modules/next/dist/docs/` is the local source
  of truth for Next.js, which is ahead of most training data.

Skip `resolving-merge-conflicts` and `domain-modeling` unless the situation
calls for them specifically.
