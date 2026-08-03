# @workspace/db

Postgres for **scheduling and provenance** — jobs, their runs, and pointers to
what those runs produced. Neon behind Prisma Client, with domain helpers for the
claim and schedule invariants that the model API cannot express alone.

## The seam

```
types.ts       domain aliases over generated Prisma models
errors.ts      the typed error union
config.ts      reads the environment
schedule.ts    computeNextRunAt — pure, and where the bugs are
users.ts       ensureUserForAuth
jobs.ts        create / claim / due / schedule helpers
runs.ts        finish / fail / startAdHoc
artifacts.ts   record / latest helpers
client.ts      createPrismaClient() — adapter + pooled URL
prisma/        schema + Prisma Migrate history
```

Two rules keep the package replaceable:

1. **`client.ts` is the only file that constructs a Prisma Client** (and the
   only place the `pg` adapter is wired).
2. **Concurrency-sensitive writes are helpers, not free-form SQL at call sites.**
   `claimJob` owns the partial-index `ON CONFLICT` target; `finishRun` /
   `failRun` own the `WHERE status = 'running'` guard.

## Using it

`createPrismaClient()` is a factory and never a module-level instance —
constructing it reads configuration, and an instance at module scope would move
that failure to _import_ time.

```ts
import { claimJob, createPrismaClient, dueJobs, finishRun } from "@workspace/db"

const prisma = createPrismaClient()

try {
  for (const job of await dueJobs(prisma)) {
    const slot = await claimJob(prisma, job)
    if (!slot) continue // someone else holds it — skip entirely

    try {
      // …produce something…
      await finishRun(prisma, slot.runId)
    } catch (error) {
      // failRun(prisma, slot.runId, …)
      throw error
    }
  }
} finally {
  await prisma.$disconnect()
}
```

Ordinary reads and writes use Prisma Client directly (`prisma.job.findMany`,
`prisma.user.upsert` via `ensureUserForAuth`, …). `@workspace/db/schedule` is
importable on its own and pulls in no driver.

## Connections

| Consumer         | Endpoint   | Variable                | Lifecycle          |
| ---------------- | ---------- | ----------------------- | ------------------ |
| Lambda worker    | pooled     | `DATABASE_URL`          | one per invocation |
| Vercel dashboard | pooled     | `DATABASE_URL`          | short-lived, many  |
| Migrations       | **direct** | `DATABASE_URL_UNPOOLED` | one per run        |

Migrations need the direct endpoint and it is not interchangeable: the pooled
endpoint fronts PgBouncer in transaction mode. `prisma.config.ts` points the
CLI at `DATABASE_URL_UNPOOLED`; runtime always uses the pooled URL through the
driver adapter.

**One Prisma Client per Lambda invocation, `$disconnect()` at the end.** The gap
between ticks is an hour and Neon autosuspends after five minutes, so a cached
socket is dead by the next invocation as the default outcome.

## Migrations

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

That runs `prisma migrate deploy` against the schema under `prisma/`. Forward-
only. Partial indexes and CHECK constraints that Prisma's schema DSL cannot
express live in the SQL of `prisma/migrations/0001_init/` — do not tidy them
into full unique constraints.

Generate the client (also part of `build` / `typecheck`):

```bash
pnpm --filter @workspace/db generate
```

## Tests

```bash
pnpm --filter @workspace/db test
```

Two suites, split by whether the thing under test needs Postgres to _be_
Postgres:

- **`schedule.test.ts` needs nothing.** DST boundaries across IANA zones, missed
  slots, the UTC partition day.
- **`stores.test.ts` needs a real database** and **skips when
  `DATABASE_URL_UNPOOLED` is unset**. It asserts the claim race, unlimited
  ad-hoc runs beside unique scheduled ones, the `object_key` CHECK, and the
  refusal to walk a terminal run back to `running`. It migrates into a schema
  it creates and drops, so it cannot touch data it did not write.

## Schema notes worth not undoing

- **`next_run_at IS NULL` means "not scheduled"**, covering both paused and
  retired. That is why there is no `enabled` column and no `retired_at`.
- **`scheduled_for IS NULL` means ad-hoc**, and is itself the manual/scheduled
  test — an `is_manual` boolean would be a second place for the same fact.
- **`runs_job_scheduled_for_key` is a partial unique index**, so unlimited
  ad-hoc runs are legal while scheduled slots stay unique. Every `ON CONFLICT`
  against it must repeat `WHERE scheduled_for IS NOT NULL`.
- **Transitions are enforced by `UPDATE … WHERE status = 'running'`**, not by a
  CHECK — a CHECK cannot see the old row.
- **`on delete restrict` throughout, never cascade.**
- **`object_key` holds an S3 key and the CHECK enforces it** — no scheme prefix,
  no leading slash.
- **`auth_user_id` is text, nullable, unique, and not an FK to `neon_auth`.**
