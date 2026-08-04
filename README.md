# control-panel

A scheduled worker turns a candidate's search criteria into a private, per-user
job-search brief; a Next.js dashboard is where the user manages their documents
and will eventually read the briefs.

Turborepo monorepo — Next.js 16 on Vercel, an AWS Lambda worker, Neon Postgres,
S3, and Terraform for all of it.

## Start here

| Read           | For                                                    |
| -------------- | ------------------------------------------------------ |
| `OVERVIEW.md`  | the pipeline end to end, and what is **not** built yet |
| `CONTEXT.md`   | the vocabulary — read before writing prose about this  |
| `CLAUDE.md`    | commands, workspace layout, and the architecture rules |
| `RELEASING.md` | shipping a change end to end — secrets, apply, verify  |
| `infra/aws/`   | the Terraform, its own README, and `DEPLOYING.md`      |

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

## Langfuse tracing

The dashboard records each chat turn as `chat-response`; the Lambda records
each briefing as `generate-briefing`. Both retain full prompts, tool I/O, and
outputs by design. The adapter behind both is `@workspace/langfuse` — see
`packages/langfuse/README.md`. Configure each runtime with:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=production
LANGCHAIN_CALLBACKS_BACKGROUND=false
```

Use the base URL for the selected Langfuse cloud region or self-hosted instance.
Dashboard variables belong in its Vercel environment; the worker fetches its
keys from AWS Secrets Manager. Do not add keys to committed files.
