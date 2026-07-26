# `@workspace/db`

The Postgres data layer: connection pooling, the Drizzle client, and the schema
that migrations are generated from.

Like `@workspace/ui`, this package has **no build step**. Its `exports` point at
TypeScript sources and consumers compile it themselves. It is standalone — no
app depends on it yet.

## Adopting it in an app

Nothing is wired up for you. To consume it from an app:

1. Add `"@workspace/db": "workspace:*"` to the app's `dependencies` and run
   `pnpm install`.
2. Add `"@workspace/db"` to `transpilePackages` in `next.config.ts` so Next
   compiles the package's TypeScript sources.
3. If pnpm is running with `node-linker=hoisted`, workspace packages get no
   `node_modules/@workspace/*` symlink, so the `exports` map above is bypassed
   and the import will not resolve. Path-map it in the app's `tsconfig.json`,
   the same workaround `@workspace/ui` already relies on:

   ```jsonc
   "paths": {
     "@workspace/db": ["../../packages/db/src/index.ts"],
     "@workspace/db/*": ["../../packages/db/src/*"]
   }
   ```

   Under the default isolated linker this step is unnecessary — the `exports`
   map resolves on its own.

## Configuration

The package reads a single environment variable, `DATABASE_URL`. Put it in
`packages/db/.env` — per-package env files keep it obvious which packages
depend on which variables:

```bash
# packages/db/.env
DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"
```

Apps that query the database need `DATABASE_URL` in their own environment too;
`drizzle-kit` reads it from this package's `.env` via `dotenv/config`.

Nothing throws until a connection is actually opened, so `pnpm build` and
`pnpm typecheck` work without a database.

## Usage

```ts
import { getDb, eq, schema } from "@workspace/db"

const db = getDb()
const rows = await db.select().from(schema.someTable).where(eq(...))
```

`getDb()` opens the pool on first call and reuses it across Next.js hot
reloads. Use `createDb()` when you need a client with a pool you own (tests,
one-off scripts) and `closeDb()` so a script's process can exit.

## Adding a table

1. Create the table in `src/schema/` — one file per table.
2. Re-export it from `src/schema/index.ts`. A table missing from that barrel is
   invisible to both relational queries and migration generation.
3. Generate and apply the migration:

```bash
pnpm db:generate   # writes SQL into packages/db/drizzle/
pnpm db:migrate    # applies pending migrations
```

Generated migrations are source — commit them.

## Connection strings

Use a **direct** (non-pooled) connection for migrations and a **pooled** one
(`-pooler` in the host for Neon) for the running app. Running migrations
through a transaction pooler will fail on statements that need session state.

## Swapping the driver

`src/client.ts` is the only file that names a driver. It uses
`drizzle-orm/node-postgres` with `pg`, which works against Neon, local
Postgres, and any long-running Node runtime, and supports transactions. For an
edge runtime, swap it for `drizzle-orm/neon-http` (or `neon-serverless`) and
`@neondatabase/serverless` — nothing outside that file changes.
