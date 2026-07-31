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
 * Ours, not Neon's — like `NEON_AUTH_COOKIE_SECRET`, generated once with
 * `openssl rand -base64 32` and set by hand. Only `mailboxes.ts` reads it.
 */
export const MAILBOX_ENCRYPTION_KEY = "MAILBOX_ENCRYPTION_KEY"

/** The key that encrypts `mailboxes.refresh_token_encrypted` at rest. */
export interface MailboxEncryptionConfig {
  /** Exactly 32 bytes — AES-256. Never log it, never echo it in an error. */
  key: Buffer
}

/**
 * A function rather than a module-level constant, for the same reason as the
 * two readers above: importing this package must never throw. The briefing
 * worker opens this same database and never touches a Mailbox, so it must
 * never need this variable — which is why the key is read here, lazily, and
 * not in `createDb()`.
 */
export function readMailboxEncryptionConfig(
  env: NodeJS.ProcessEnv = process.env
): MailboxEncryptionConfig {
  const encoded = env[MAILBOX_ENCRYPTION_KEY]?.trim()
  if (!encoded) {
    throw new Error(
      `${MAILBOX_ENCRYPTION_KEY} is not set, so the Gmail refresh token cannot be ` +
        `read or written. Generate one with \`openssl rand -base64 32\`.`
    )
  }

  // `Buffer.from(…, "base64")` never throws — it decodes what it can — so the
  // length check below is also what catches a value that was not base64.
  const key = Buffer.from(encoded, "base64")

  if (key.length !== 32) {
    throw new Error(
      `${MAILBOX_ENCRYPTION_KEY} must be 32 bytes of base64 (openssl rand -base64 32); ` +
        `decoded ${key.length} bytes instead.`
    )
  }

  return { key }
}

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
