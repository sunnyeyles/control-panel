/**
 * Every failure this package raises, as one closed set.
 *
 * The `code` discriminant is the part callers should branch on. `instanceof`
 * works too, but it breaks the moment two copies of this package end up in a
 * dependency graph, and a bundled worker is exactly where that happens — so the
 * string is the contract and the classes are a convenience.
 */
export type DbErrorCode = "invalid_schedule"

/**
 * Base for everything below. Never thrown directly.
 *
 * Still abstract with a single subclass, because the discriminant above is what
 * callers branch on and a second code is expected to arrive with the next
 * failure this package chooses to own.
 */
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
 * The parse *is* the validation: there is no CHECK constraint on
 * `schedule_cron`. An expression that reaches the database has already produced
 * a `next_run_at`, so a job cannot be stored with a schedule that will never
 * fire.
 */
export class InvalidScheduleError extends DbError {
  readonly code = "invalid_schedule" as const
}

// Note what is deliberately absent: a `DatabaseUnavailableError`. One existed
// and was never thrown — connection, permission and transport faults propagate
// as Prisma's own errors, and constraint violations keep Prisma's / Postgres's
// codes so a duplicate name can still be recognised as `P2002` / `23505` (see
// `isUniqueViolation` below). Add one when something actually raises it.
//
// A line comment, not a doc block: TypeScript attaches every leading `/** */` to
// the next declaration, so this would surface in `isDbError`'s hover text.

/** Narrows an unknown catch binding to this package's errors. */
export function isDbError(error: unknown): error is DbError {
  return error instanceof Error && "code" in error && isErrorCode(error.code)
}

/**
 * Prisma unique-constraint violations (`P2002`) and raw Postgres `23505`.
 *
 * Dashboard create actions branch on this: a duplicate `(user_id, name)` is a
 * user-facing message, not an opaque digest.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  const code = (error as { code?: unknown }).code
  return code === "P2002" || code === "23505"
}

function isErrorCode(value: unknown): value is DbErrorCode {
  return value === "invalid_schedule"
}
