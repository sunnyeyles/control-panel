// Note what is deliberately absent: a typed error union. Connection, permission
// and transport faults propagate as Prisma's own errors, and constraint
// violations keep Prisma's / Postgres's codes so a duplicate can still be
// recognised as `P2002` / `23505`. Add a union when something actually raises
// one of its own.
//
// A line comment, not a doc block: TypeScript attaches every leading `/** */` to
// the next declaration, so this would surface in `isUniqueViolation`'s hover text.

/**
 * Prisma unique-constraint violations (`P2002`) and raw Postgres `23505`.
 *
 * `ensureUserForAuth` branches on this: losing the insert race to a concurrent
 * first request is an ordinary answer, not a failure.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  const code = (error as { code?: unknown }).code
  return code === "P2002" || code === "23505"
}
