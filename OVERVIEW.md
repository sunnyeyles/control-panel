# What is built

A Next.js dashboard with three things in it: a chat **Assistant** that can look
up the time and search the web, a shelf of **Documents** the user uploaded, and a
**Whiteboard** the user and an agent draw on together.

Vocabulary is in `CONTEXT.md`, and it is worth reading first — in particular
`resumes` is the storage kind every upload goes on, whatever the document is.

⚠️ The Neon database was deleted on 2026-08-15, so the deployed dashboard cannot
authenticate. `CLAUDE.md` opens with what that does and does not change.

## Where it lives

| Part                                   | Owner                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dashboard — `/`, documents, whiteboard | `apps/dashboard/` (Next.js 16 App Router, Vercel)                                                                     |
| The Assistant at `/`                   | `apps/dashboard/lib/chat-handler.ts` behind `POST /api/chat`, over `createAssistant`                                  |
| Documents at `/documents`              | `apps/dashboard/lib/documents/`, rows in `packages/db/src/documents.ts`, bytes through `packages/user-storage/`       |
| The Whiteboard at `/whiteboard`        | `apps/dashboard/lib/whiteboard/` — a turn behind `POST /api/whiteboard`, the snapshot behind `/api/whiteboard/board`  |
| Settings at `/settings`                | `apps/dashboard/app/(app)/settings/` — appearance, for now                                                            |
| Sign-in, the allowlist, the gate       | `apps/dashboard/proxy.ts`, `apps/dashboard/lib/auth/` — see `apps/dashboard/CLAUDE.md`                                |
| The named agents                       | `packages/agents/src/` — `assistant.ts` and `whiteboard.ts`, one `createX()` factory each                             |
| The tool catalog                       | `packages/agent-tools/src/` — `time.ts` and `web-search.ts` at the root, the canvas tools under `whiteboard/`         |
| The whiteboard wire contract           | `packages/whiteboard-schema/src/` — zod only; imported by both the canvas tools and the dashboard's client components |
| Agent graph, state, model              | `packages/agents-core/src/`                                                                                           |
| Users, documents, boards               | `packages/db/src/` (Prisma Client + domain helpers) and `packages/db/prisma/`                                         |
| Whiteboard evals                       | `packages/agents/evals/` — see its README                                                                             |
| S3 read/write                          | `packages/user-storage/src/` — extend `resume-store.ts`, never import the AWS SDK elsewhere                           |
| Langfuse tracing                       | `packages/langfuse/src/`, wired in `apps/dashboard/instrumentation-node.ts`                                           |
| Bucket, dashboard IAM, alerts topic    | `infra/aws/` (`user-storage.tf`, `vercel-dashboard.tf`, `alerting.tf`)                                                |

`docs/agent-architecture.md` is the view underneath the agent rows: the package
layering, the graph, and which agent carries which tools.

## Rules

- **S3 stays private.** Neon stores object keys only — never URLs, never blob
  content. A Document's row holds the id that _is_ its key segment, and the
  bytes are streamed back through `/api/documents/[file]`.
- **The object is written before the row.** A failure then leaves an object
  nothing names rather than a row naming nothing.
- **The Assistant's tools are pinned.** `ASSISTANT_TOOLS` is `get_current_time`
  and `web_search`, and `assistant.test.ts` holds it there — widening it widens
  what a chat agent can do for anyone who can reach the chat.
- **The browser owns the whiteboard.** The server's copy lives for one turn;
  the snapshot is what the browser saves, and the server never reads inside it.
- **New `kinds.ts` entries need a matching `object_kinds` entry in Terraform**,
  or the objects get no retention and writes 403 for want of the per-kind grant.
- **Tracing is opt-in and never load-bearing.** `@workspace/langfuse` is a no-op
  without keys, and a turn must behave identically either way.

## Infrastructure

- Frontend and application on Vercel; database is Neon Postgres, reached through
  Prisma Client over a `pg` driver adapter.
- S3 privately stores uploaded documents under the `resumes` kind. IAM is
  least-privilege and bounded by a permissions boundary; grants are per
  environment and kind, and the dashboard's Vercel OIDC role holds
  `prod:resumes`.
- An SNS alerts topic is kept with its confirmed email subscription, though
  nothing publishes to it today — see `infra/aws/alerting.tf` for why it stays.
- All AWS infrastructure is Terraform under `infra/aws/`, which Turborepo does
  not cover; `.github/workflows/deploy-infra.yml` applies it from `main`.
- Langfuse receives one trace per agent turn when its keys are present:
  `chat-response` and `whiteboard-turn`. Both retain full prompts, tool I/O and
  outputs by design — which for a whiteboard turn includes every label on the
  user's board, rendered into the system prompt — so the keys are what decides
  whether that leaves the machine.

## Design requirements

- Keep AWS-specific code behind adapters. Exactly two non-test files import the
  S3 SDK — `packages/user-storage/src/s3-user-object-store.ts`, and
  `apps/dashboard/lib/storage.ts`, which exists only to attach Vercel's OIDC
  credential provider through the store's `client` seam. The package deliberately
  accepts no credentials.
- Never make the bucket public, and never store a public URL as the file
  reference; the object key is the persistent reference.
- Design for local development and automated testing: every handler and Server
  Action takes its user, its database, its store and its agent through `*Deps`
  seams, and `DEV_AUTH_BYPASS=1` serves the whole app against in-memory fixtures.
