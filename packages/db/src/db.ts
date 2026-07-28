import { createArtifactStore, type ArtifactStore } from "./artifacts.ts"
import { createConnection } from "./client.ts"
import { readDatabaseConfig, type DatabaseConfig } from "./config.ts"
import { createJobStore, type JobStore } from "./jobs.ts"
import { createRunStore, type RunStore } from "./runs.ts"
import { createUserStore, type UserStore } from "./users.ts"

/**
 * One connection's worth of database access, as four narrow facades.
 *
 * There is no `query()` here and there will not be one. That absence *is* the
 * ORM-agnostic seam: every line of SQL in this repository lives inside
 * `packages/db`, so adopting a query builder later rewrites this package's
 * interior and touches no caller. One raw query leaked into the worker or the
 * dashboard and the property is gone — the same reason
 * `s3-user-object-store.ts` is the only file that imports the AWS SDK.
 *
 * The dashboard reads Postgres through this too, never directly. The connection
 * defaults differ per runtime, but that is which string is passed to
 * `createDb()`, not a second data path.
 */
export interface Db {
  users: UserStore
  jobs: JobStore
  runs: RunStore
  artifacts: ArtifactStore

  /**
   * Close the connection. **Always call it**, in a `finally`.
   *
   * On Lambda the process is frozen rather than torn down between invocations,
   * so a socket left open is one Neon keeps accounting for while nothing is
   * using it.
   */
  close(): Promise<void>
}

/**
 * Open the database.
 *
 * A factory and never a module-level instance: constructing this reads
 * configuration, so an instance at module scope would move that failure to
 * *import* time and break any consumer that merely imports the module — the
 * same rule that governs `createAgent()` and `createS3UserObjectStore()`.
 *
 * One of these per invocation, closed at the end. Not cached at module scope:
 * the gap between ticks is an hour and Neon autosuspends after five minutes, so
 * a reused socket is dead as the *default* outcome rather than as an edge case.
 *
 * With no argument it reads `DATABASE_URL` — the pooled endpoint, which is
 * correct for both runtimes at runtime. Migrations are the exception and take
 * the direct endpoint; `runMigrations()` already defaults to it.
 */
export function createDb(config: DatabaseConfig = readDatabaseConfig()): Db {
  const connection = createConnection(config)

  return {
    users: createUserStore(connection),
    jobs: createJobStore(connection),
    runs: createRunStore(connection),
    artifacts: createArtifactStore(connection),
    close: () => connection.close(),
  }
}
