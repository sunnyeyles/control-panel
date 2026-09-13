# control-panel

A single-user dashboard: a chat assistant that can search the web, a shelf for
the documents you upload, and a whiteboard you draw on together with an agent.

Turborepo monorepo — Next.js 16 on Vercel, Neon Postgres, S3, and Terraform for
the AWS side. The Neon database was deleted on 2026-08-15, so the deployed
dashboard does not currently run; `CLAUDE.md` opens with what that means.

## Start here

| Read           | For                                                    |
| -------------- | ------------------------------------------------------ |
| `OVERVIEW.md`  | what is built, where it lives, and the rules it keeps  |
| `CONTEXT.md`   | the vocabulary — read before writing prose about this  |
| `CLAUDE.md`    | commands, workspace layout, and the architecture rules |
| `RELEASING.md` | shipping a change end to end — secrets, apply, verify  |
| `infra/aws/`   | the Terraform, its own README, and `DEPLOYING.md`      |

`CONTEXT.md` first if you are about to name something: `resumes` is the storage
kind every upload goes on, not a folder of CVs — an upload is a **document**.

## Commands

```bash
pnpm dev         # next dev for apps/dashboard
pnpm build       # turbo build
pnpm test        # turbo test — not every workspace has tests; CLAUDE.md lists them
pnpm lint        # eslint; never fails, so read the warnings
pnpm typecheck   # tsc --noEmit per workspace
```

Terraform and database migrations are **not** covered by Turborepo and run on
their own; `CLAUDE.md` has both incantations.

To edit the UI without signing in, set `DEV_AUTH_BYPASS=1` in
`apps/dashboard/.env.local`. `pnpm dev` then serves every page as a fixed dev
user against in-memory fixtures, needing no database, no AWS credentials and no
`NEON_*` variables — and refusing to start at all if it ever reaches a
production build. See `apps/dashboard/CLAUDE.md`.

## Langfuse tracing

The dashboard records each chat turn as `chat-response` and each whiteboard turn
as `whiteboard-turn`. Both retain full prompts, tool I/O, and outputs by design.
The adapter behind both is `@workspace/langfuse` — see
`packages/langfuse/README.md`. Configure the dashboard with:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=production
LANGCHAIN_CALLBACKS_BACKGROUND=false
```

Use the base URL for the selected Langfuse cloud region or self-hosted instance.
Dashboard variables belong in its Vercel environment; the whiteboard evals read
the same keys from the shell or from repository secrets — see
`packages/agents/evals/README.md`. Do not add keys to committed files.
