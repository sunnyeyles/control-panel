# control-panel

A scheduled worker turns a candidate's search criteria into a private, per-user
job-search brief; a Next.js dashboard is where the user manages their documents
and will eventually read the briefs.

Turborepo monorepo — Next.js 16 on Vercel, an AWS Lambda worker, Neon Postgres,
S3, and Terraform for all of it.

## Start here

| Read          | For                                                    |
| ------------- | ------------------------------------------------------ |
| `OVERVIEW.md` | the pipeline end to end, and what is **not** built yet |
| `CONTEXT.md`  | the vocabulary — read before writing prose about this  |
| `CLAUDE.md`   | commands, workspace layout, and the architecture rules |
| `infra/aws/`  | the Terraform, its own README, and `DEPLOYING.md`      |

`CONTEXT.md` first if you are about to name something: **job** means a row in
`jobs`, a thing that runs on a cadence, never an employment opportunity — that
is a **posting**.

## Commands

```bash
pnpm dev         # next dev for apps/dashboard
pnpm build       # turbo build
pnpm test        # turbo test — only five workspaces have any
pnpm lint        # eslint; never fails, so read the warnings
pnpm typecheck   # tsc --noEmit per workspace
```

Terraform and database migrations are **not** covered by Turborepo and run on
their own; `CLAUDE.md` has both incantations.
