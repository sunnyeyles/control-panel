# @workspace/db

Postgres for **scheduling and provenance** — jobs, their runs, and pointers to
what those runs produced. Neon behind an interface, and the only place SQL
lives.

## The seam

```
rows.ts        row types, hand-written                          no pg import
errors.ts      the typed error union                            no pg import
config.ts      reads the environment                            no pg import
schedule.ts    computeNextRunAt — pure, and where the bugs are  no pg import
users.ts       UserStore facade                                 no pg import
jobs.ts        JobStore facade, and the claim                   no pg import
runs.ts        RunStore facade, and the transition guard        no pg import
artifacts.ts   ArtifactStore facade                             no pg import
migrate.ts     the migration runner                             no pg import
client.ts      createConnection()                               the only pg import
```

Two rules make this package replaceable:

1. **`client.ts` is the only file that imports a driver**, exactly as
   `s3-user-object-store.ts` is the only file in the repo that imports the AWS
   SDK.
2. **There is no generic query surface.** No exported `query()`, no escape hatch
   returning raw rows. Callers express intent; they never write SQL.

Together those mean adopting an ORM or query builder later rewrites this
package's interior and touches no caller. Leak one raw query into the worker or
the dashboard and the property is gone.

The one construct to check any candidate builder against: `ON CONFLICT … WHERE`
predicate inference on a **partial** unique index. Every candidate can emit it
as raw SQL; not every one expresses it natively.

## Using it

`createDb()` is a factory and never a module-level instance — constructing it
reads configuration, and an instance at module scope would move that failure to
_import_ time.

```ts
import { createDb } from "@workspace/db"

const db = createDb()

try {
  for (const job of await db.jobs.dueJobs()) {
    const slot = await db.jobs.claim(job)
    if (!slot) continue // someone else holds it — skip entirely

    try {
      const key = await produceSomething(job)
      await db.artifacts.record(slot.runId, key)
      await db.runs.finish(slot.runId)
    } catch (error) {
      await db.runs.fail(slot.runId, { message: String(error) })
      throw error
    }
  }
} finally {
  await db.close()
}
```

`@workspace/db/schedule` is importable on its own and pulls in no driver.

## Connections

| Consumer         | Endpoint   | Variable                | Lifecycle          |
| ---------------- | ---------- | ----------------------- | ------------------ |
| Lambda worker    | pooled     | `DATABASE_URL`          | one per invocation |
| Vercel dashboard | pooled     | `DATABASE_URL`          | short-lived, many  |
| Migrations       | **direct** | `DATABASE_URL_UNPOOLED` | one per run        |

Migrations need the direct endpoint and it is not interchangeable: the pooled
endpoint fronts PgBouncer in transaction mode, which does not carry the
session-level advisory lock the runner takes across statements. Run migrations
through the pooler and the lock appears to be taken while holding nothing.

**One `Client` per invocation on Lambda, closed at the end.** No module-scope
reuse and no pool above one. The gap between ticks is an hour and Neon
autosuspends after five minutes, so a cached socket is dead by the next
invocation as the default outcome, not as an edge case.

The Lambda reads its connection string from Secrets Manager via
`DATABASE_SECRET_ID`, mirroring `OPENAI_SECRET_ID` — that convention exists to
keep secret values out of Terraform state, and a connection string carries a
password.

## Migrations

```bash
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

Numbered plain `.sql` files applied in filename order, a `schema_migrations`
ledger, a session advisory lock for the duration, and one transaction per file.
Idempotent — running it twice does nothing.

The script runs `src/migrate-cli.ts` through `tsx`, not the compiled copy in
`dist/`. No build step is required first, and there is no way to apply a stale
one by forgetting it.

**Forward-only. There are no down migrations.** An unwanted change is undone by
writing the next one. That is the accepted cost of not adopting Atlas, and the
files stay plain SQL precisely so Atlas remains available later.

Zero-pad new filenames to four digits (`0002_…`). The sort is lexicographic, so
a file named `10_…` would apply before `0002_…`.

Migrations do **not** run at Lambda startup. Every cold start would race every
other one for a schema it does not need.

## Tests

```bash
pnpm --filter @workspace/db test
```

Two suites, split by whether the thing under test needs Postgres to _be_
Postgres:

- **`schedule.test.ts` needs nothing.** DST boundaries across IANA zones, missed
  slots, the UTC partition day. This is where the real bugs live, and it is the
  entire argument for `computeNextRunAt` being application code rather than a
  database trigger.
- **`stores.test.ts` needs a real database** and **skips when
  `DATABASE_URL_UNPOOLED` is unset**, so `pnpm test` stays runnable with no
  credentials. It asserts the claim race, unlimited ad-hoc runs beside unique
  scheduled ones, the `object_key` CHECK, and the refusal to walk a terminal run
  back to `running` — all properties of the database, none of which a mocked
  driver could assert. It runs inside a schema it creates and drops, so it
  cannot touch data it did not write.

`CLAUDE.md`'s warning still holds: `turbo test` is a no-op in packages without
Vitest, so a clean exit code proves nothing on its own.

## Schema notes worth not undoing

- **`next_run_at IS NULL` means "not scheduled"**, covering both paused and
  retired. That is why there is no `enabled` column and no `retired_at`.
- **`scheduled_for IS NULL` means ad-hoc**, and is itself the manual/scheduled
  test — an `is_manual` boolean would be a second place for the same fact to
  live, and two places can disagree.
- **`runs_job_scheduled_for_key` is a partial unique index**, so unlimited
  ad-hoc runs are legal while scheduled slots stay unique. Every `ON CONFLICT`
  against it must repeat `WHERE scheduled_for IS NOT NULL`, or the statement
  errors out.
- **Transitions are enforced by `UPDATE … WHERE status = 'running'`**, not by a
  CHECK — a CHECK cannot see the old row. Zero rows affected means the run was
  already terminal: a lost race, not an error to retry.
- **`on delete restrict` throughout, never cascade.** Deleting a job with runs
  should fail loudly rather than silently erase provenance.
- **`object_key` holds an S3 key and the CHECK enforces it** — no scheme prefix,
  no leading slash. There is no `kind` column; the key already encodes it and
  `parseObjectKey()` recovers it, which is why this package does not depend on
  `@workspace/user-storage` at all.
