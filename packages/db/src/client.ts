import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { getDatabaseUrl } from "./env.js"
import * as schema from "./schema/index.js"

export type Database = NodePgDatabase<typeof schema>

/**
 * Next.js recreates modules on every hot reload in development, which would
 * leak a new connection pool per reload. Stashing the pool on `globalThis`
 * keeps a single pool alive across reloads.
 */
const globalForDb = globalThis as typeof globalThis & {
  __workspaceDbPool?: Pool
  __workspaceDb?: Database
}

/** Opens a new connection pool. Prefer {@link getDb} for application code. */
export function createPool(connectionString = getDatabaseUrl()): Pool {
  return new Pool({ connectionString })
}

/** Wraps a pool in a Drizzle client. Useful for tests that own their pool. */
export function createDb(pool: Pool = createPool()): Database {
  return drizzle(pool, { schema })
}

/**
 * The shared database client. The pool is opened on first use, so importing
 * this module does not require `DATABASE_URL` to be present.
 */
export function getDb(): Database {
  if (!globalForDb.__workspaceDb) {
    globalForDb.__workspaceDbPool ??= createPool()
    globalForDb.__workspaceDb = createDb(globalForDb.__workspaceDbPool)
  }

  return globalForDb.__workspaceDb
}

/** Closes the shared pool. Call from scripts so the process can exit. */
export async function closeDb(): Promise<void> {
  await globalForDb.__workspaceDbPool?.end()
  globalForDb.__workspaceDbPool = undefined
  globalForDb.__workspaceDb = undefined
}
