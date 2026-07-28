// The `db` subpath, not the package barrel. The barrel re-exports the migration
// runner, which resolves its migrations directory from `import.meta.url` —
// Turbopack cannot follow that and fails the production build with a
// module-not-found on `../migrations`. Nothing here runs migrations anyway;
// those are a deliberate by-hand step against the unpooled URL.
import { createDb, type Db } from "@workspace/db/db"

/**
 * The dashboard's database handle, one per server instance.
 *
 * Memoized rather than constructed per request: `createDb()` opens a connection,
 * and a serverless instance that handles many requests should not open many.
 * Still a function rather than a module-level `const` — constructing it reads
 * `DATABASE_URL`, and the repo's rule is that configuration is read when
 * something asks for it, not at import time.
 *
 * Known limitation, inherited from `@workspace/db`: the connection is a single
 * `pg.Client`, not a `Pool`, so concurrent requests on one instance serialise
 * their queries. Fine at this scale — the only query on the request path is the
 * identity upsert — and fixing it belongs in that package, not here.
 */
let db: Db | undefined

export function getDb(): Db {
  db ??= createDb()
  return db
}
