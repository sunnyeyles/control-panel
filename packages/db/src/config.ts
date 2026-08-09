/** Everything a connection needs. Credentials live inside the string. */
export interface DatabaseConfig {
  /** A libpq connection URI. Carries the password, so never log it. */
  connectionString: string
  /**
   * Optional Postgres schema for `search_path`.
   *
   * Used by the integration suite to pin a throwaway schema. Production
   * callers leave this unset and use the connection's default (`public`).
   */
  schema?: string
}

/**
 * The variables this package reads, and what each one is for.
 *
 * Vercel's Neon integration owns these strings and this package does not
 * re-provision them; it consumes what the integration sets. Both point at the
 * same database and differ only in which endpoint they terminate on.
 */
const DATABASE_URL = "DATABASE_URL"
const DATABASE_URL_UNPOOLED = "DATABASE_URL_UNPOOLED"

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

// There is deliberately no `readMigrationConfig()` beside it. Migrations use the
// direct, unpooled endpoint — the pooled one fronts PgBouncer in transaction
// mode, which forbids the session-level advisory lock the migration runner takes
// to keep two concurrent deploys from interleaving — but nothing in this package
// reads it. `prisma.config.ts` reads `DATABASE_URL_UNPOOLED` itself, so a second
// reader here was a convention with no caller.
//
// A line comment, not a doc block: TypeScript attaches a leading `/** */` to the
// next declaration, which would make this the hover text for `required()`.

/**
 * The prefix Vercel's Neon integration writes its variables under.
 *
 * The integration provisions `storage_DATABASE_URL` rather than the bare name,
 * and the value is an `integration-store-secret` reference that Vercel resolves
 * per deployment — which is what lets a preview deployment reach *its own* Neon
 * branch instead of main's. A hand-added plain `DATABASE_URL` shadows it and
 * pins every preview to whichever branch that value names, which is the state
 * this repo was in: CI applied each pull request's migrations to
 * `preview/<branch>` (`.github/workflows/migrate.yml`) while the deployed app
 * connected to main and never saw them.
 *
 * Read as a fallback rather than as the primary name so nothing changes for an
 * environment that sets the bare name, and so a local `.env.local` — which the
 * integration knows nothing about — keeps working.
 */
const INTEGRATION_PREFIX = "storage_"

function required(env: NodeJS.ProcessEnv, name: string): string {
  // `||`, not `??`: an empty or whitespace-only bare name should fall through to
  // the integration's value rather than count as "set" and then throw below.
  const value = env[name]?.trim() || env[`${INTEGRATION_PREFIX}${name}`]?.trim()
  if (value) return value

  throw new Error(
    `${name} is not set (nor ${INTEGRATION_PREFIX}${name}). @workspace/db reads ${DATABASE_URL} for the application (the pooled endpoint) ` +
      `and ${DATABASE_URL_UNPOOLED} for migrations (the direct endpoint, because the pooler breaks ` +
      `session-level advisory locks). Vercel's Neon integration provisions both, under ${INTEGRATION_PREFIX}.`
  )
}
