import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createConnection, type Connection } from "./client.js"
import { readMigrationConfig, type DatabaseConfig } from "./config.js"
import { MigrationError } from "./errors.js"

/**
 * Numbered `.sql` files and a small runner. No Atlas, no ORM-attached tool.
 *
 * The artifact is plain SQL, which is what keeps the deferred ORM decision
 * cheap — and is also exactly what Atlas's versioned mode consumes, if this
 * schema ever churns enough to justify a Go binary in everyone's path.
 *
 * **Forward-only.** There are no down migrations, so an unwanted change is
 * undone by writing the next one. That is the honest cost of declining Atlas
 * and it is tolerable at four tables.
 */

/**
 * A fixed key, so every deploy contends for the same lock. Arbitrary but
 * permanent: changing it would let an old runner and a new one apply files
 * simultaneously, which is the one thing the lock exists to prevent.
 */
const ADVISORY_LOCK_KEY = 4_050_218_264

/**
 * Where `0001_init.sql` and its successors live.
 *
 * Resolved from this module's own URL so it works from `dist/migrate.js` and
 * from `src/migrate.ts` under Vitest alike. A bundler that inlines this file
 * without the sibling directory must pass `directory` explicitly.
 */
const DEFAULT_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url)
)

export interface RunMigrationsOptions {
  /**
   * Defaults to `DATABASE_URL_UNPOOLED` — the **direct** endpoint.
   *
   * Not the pooled one, and not interchangeable with it. PgBouncer in
   * transaction mode does not carry a session-level advisory lock across
   * statements, so through the pooler the lock below would appear to be taken
   * and would hold nothing.
   */
  config?: DatabaseConfig
  /** Overrides where migration files are read from. */
  directory?: string
  /** Called once per file as it is applied. */
  onApplied?: (filename: string) => void
}

export interface MigrationsResult {
  /** Filenames applied by this run, in order. */
  applied: string[]
  /** Filenames that were already recorded. */
  skipped: string[]
}

/**
 * Apply every unapplied migration, in filename order.
 *
 * Two concurrent runners cannot interleave: the session advisory lock is taken
 * for the whole run, so the second waits and then finds nothing to do. Each
 * file runs in its own transaction, so a failure rolls that file back and stops
 * — a schema half-applied at a nameable file beats one half-applied in the
 * middle of an unknown one.
 *
 * Idempotent. Running it twice is a no-op.
 */
export async function runMigrations(
  options: RunMigrationsOptions = {}
): Promise<MigrationsResult> {
  const directory = options.directory ?? DEFAULT_DIRECTORY
  const files = await migrationFiles(directory)
  const connection = createConnection(options.config ?? readMigrationConfig())

  try {
    // Session-scoped and blocking. Held until it is released below or the
    // connection closes, whichever happens first — so a runner that crashes
    // does not leave the lock behind.
    await connection.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY])

    try {
      await ensureLedger(connection)
      const already = await appliedFilenames(connection)

      const applied: string[] = []
      const skipped: string[] = []

      for (const filename of files) {
        if (already.has(filename)) {
          skipped.push(filename)
          continue
        }

        const sql = await readFile(join(directory, filename), "utf8")
        await apply(connection, filename, sql)

        applied.push(filename)
        options.onApplied?.(filename)
      }

      return { applied, skipped }
    } finally {
      await connection
        .query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
        .catch(() => undefined)
    }
  } finally {
    await connection.close()
  }
}

/** Which migrations a database has already had, for a status command or a test. */
export async function appliedMigrations(
  config: DatabaseConfig = readMigrationConfig()
): Promise<string[]> {
  const connection = createConnection(config)

  try {
    await ensureLedger(connection)
    return [...(await appliedFilenames(connection))].sort()
  } finally {
    await connection.close()
  }
}

/**
 * The ledger, created outside any migration file.
 *
 * It cannot live in `0001_init.sql` — the runner has to read it to decide
 * whether to apply that file at all.
 */
async function ensureLedger(connection: Connection): Promise<void> {
  await connection.query(
    `create table if not exists schema_migrations (
       filename   text        not null primary key,
       applied_at timestamptz not null default now()
     )`
  )
}

async function appliedFilenames(connection: Connection): Promise<Set<string>> {
  const { rows } = await connection.query<{ filename: string }>(
    "select filename from schema_migrations"
  )

  return new Set(rows.map((row) => row.filename))
}

/**
 * One file, one transaction, and the ledger row written inside it.
 *
 * Inside, so "the file ran" and "the file is recorded" cannot come apart. A
 * migration containing `CREATE INDEX CONCURRENTLY` would break this, since that
 * statement cannot run in a transaction — there is none today, and the fix when
 * there is one is to give that file its own path rather than to weaken this.
 */
async function apply(
  connection: Connection,
  filename: string,
  sql: string
): Promise<void> {
  try {
    await connection.transaction(async (tx) => {
      await tx.query(sql)
      await tx.query("insert into schema_migrations (filename) values ($1)", [
        filename,
      ])
    })
  } catch (cause) {
    throw new MigrationError(filename, { cause })
  }
}

/**
 * `.sql` files in filename order.
 *
 * Plain lexicographic sort, which is why the numeric prefix is zero-padded:
 * `0010` after `0009` only works while every name is the same width. A file
 * added as `10_…` would sort before `0002_…` and apply out of order.
 */
async function migrationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory)

  return entries.filter((name) => name.endsWith(".sql")).sort()
}
