/**
 * Reads the Postgres connection string from the environment.
 *
 * Deliberately a function rather than a module-level constant: importing this
 * package must never throw, so the check happens when a connection is actually
 * opened. Builds, typechecks, and tests that never touch the database do not
 * need `DATABASE_URL` to be set.
 */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to packages/db/.env (or the process " +
        "environment) before opening a database connection."
    )
  }

  return url
}
