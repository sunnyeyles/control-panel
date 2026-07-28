/** Everything a connection needs. Credentials live inside the string. */
export interface DatabaseConfig {
  /** A libpq connection URI. Carries the password, so never log it. */
  connectionString: string
}

/**
 * The variables this package reads, and what each one is for.
 *
 * Vercel's Neon integration owns these strings and this package does not
 * re-provision them; it consumes what the integration sets. Both point at the
 * same database and differ only in which endpoint they terminate on.
 */
export const DATABASE_URL = "DATABASE_URL"
export const DATABASE_URL_UNPOOLED = "DATABASE_URL_UNPOOLED"

/**
 * The connection the application uses at runtime — the **pooled** endpoint.
 *
 * A function rather than a module-level constant, mirroring
 * `readUserStorageConfig()` and for the same reason: importing this package
 * must never throw. A build, a typecheck, or a consumer that only wants
 * `computeNextRunAt` has no database to point at and should not need one.
 */
export function readDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env
): DatabaseConfig {
  return { connectionString: required(env, DATABASE_URL) }
}

/**
 * The connection **migrations** use — the direct, unpooled endpoint.
 *
 * Not interchangeable with the one above. The pooled endpoint fronts PgBouncer
 * in transaction mode, which forbids the session-level advisory lock the
 * migration runner takes to keep two concurrent deploys from interleaving. Run
 * migrations through the pooler and the lock silently does not hold.
 */
export function readMigrationConfig(
  env: NodeJS.ProcessEnv = process.env
): DatabaseConfig {
  return { connectionString: required(env, DATABASE_URL_UNPOOLED) }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value) return value

  throw new Error(
    `${name} is not set. @workspace/db reads ${DATABASE_URL} for the application (the pooled endpoint) ` +
      `and ${DATABASE_URL_UNPOOLED} for migrations (the direct endpoint, because the pooler breaks ` +
      `session-level advisory locks). Vercel's Neon integration provisions both.`
  )
}
