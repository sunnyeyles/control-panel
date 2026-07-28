/**
 * Every failure this package raises, as one closed set.
 *
 * The `code` discriminant is the part callers should branch on. `instanceof`
 * works too, but it breaks the moment two copies of this package end up in a
 * dependency graph, and a bundled worker is exactly where that happens — so the
 * string is the contract and the classes are a convenience. Same arrangement as
 * `@workspace/user-storage`, and for the same reason.
 */
export type DbErrorCode =
  "invalid_schedule" | "migration_failed" | "database_unavailable"

/** Base for everything below. Never thrown directly. */
export abstract class DbError extends Error {
  abstract readonly code: DbErrorCode

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * A cron expression or timezone cannot produce a next occurrence.
 *
 * This is the load-bearing one, because the parse *is* the validation: there is
 * no CHECK constraint on `schedule_cron` and there could not be one — Postgres
 * cannot parse cron without an extension. An expression that reaches the
 * database has already produced a `next_run_at`, so a job cannot be stored with
 * a schedule that will never fire.
 */
export class InvalidScheduleError extends DbError {
  readonly code = "invalid_schedule" as const
}

/**
 * A migration file failed to apply.
 *
 * Its own transaction is already rolled back by the time this is thrown, and
 * the runner stops rather than trying the next file — a schema half-applied in
 * filename order is worse than one that stopped somewhere nameable.
 */
export class MigrationError extends DbError {
  readonly code = "migration_failed" as const

  constructor(
    readonly filename: string,
    options?: { cause?: unknown }
  ) {
    super(
      `Migration ${filename} failed and was rolled back. Migrations are forward-only, so fix the file or write the next one; nothing after ${filename} was applied.`,
      options
    )
  }
}

/**
 * The database refused or could not be reached.
 *
 * Wraps connection, permission and transport faults alike. The distinction that
 * matters to a caller is "the data is wrong" versus "the database is", and this
 * is the second one; `cause` carries the driver error for logging.
 */
export class DatabaseUnavailableError extends DbError {
  readonly code = "database_unavailable" as const
}

/** Narrows an unknown catch binding to this package's errors. */
export function isDbError(error: unknown): error is DbError {
  return error instanceof Error && "code" in error && isErrorCode(error.code)
}

function isErrorCode(value: unknown): value is DbErrorCode {
  return (
    value === "invalid_schedule" ||
    value === "migration_failed" ||
    value === "database_unavailable"
  )
}
