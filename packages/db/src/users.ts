import { isUniqueViolation } from "./errors.ts"
import type { PrismaClient } from "./generated/prisma/client.ts"
import type { User } from "./types.ts"

type DbClient = PrismaClient

/**
 * The platform user behind a Neon Auth identity, creating it on first sight.
 *
 * Called on every authenticated request — every page load, every navigation,
 * every Server Action — so what it costs is paid in front of everything else on
 * the page. `getCurrentUser` in the dashboard wraps its caller in React's
 * `cache()`, which makes that once per request rather than twice; it does not
 * make it free.
 *
 * ⚠️ **Read first, and create only on a miss.** This was a `prisma.user.upsert`,
 * which on Postgres compiles to `INSERT … ON CONFLICT DO UPDATE` — a write
 * transaction, with a WAL flush, on every authenticated request, to maintain a
 * mapping that is immutable once created. The overwhelmingly common case is a
 * row that already exists, and answering it is now an index-only read on
 * `users_auth_user_id_key`.
 *
 * ⚠️ **The contract is idempotent and race-safe, not "one statement".** That is
 * what the previous shape was really buying, and it is what this one still
 * provides: two concurrent first requests for the same identity are the normal
 * case, not an edge, so one of them loses the `INSERT` to the unique index and
 * re-reads what the winner wrote. `stores.test.ts` drives exactly that with two
 * clients, and asserts one row.
 *
 * The re-read is the only place a `null` would be a real surprise — the
 * constraint fired, so a row exists — so a miss there re-throws the original
 * violation rather than inventing a message for something that cannot happen.
 */
export async function ensureUserForAuth(
  prisma: DbClient,
  authUserId: string
): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { authUserId } })
  if (existing !== null) return existing

  try {
    return await prisma.user.create({ data: { authUserId } })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error

    // Someone else created it between the read and the write. Their row is the
    // one row, and it is the answer.
    const won = await prisma.user.findUnique({ where: { authUserId } })
    if (won === null) throw error

    return won
  }
}
