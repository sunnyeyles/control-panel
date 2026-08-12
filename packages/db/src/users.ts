import { isUniqueViolation } from "./errors.ts"
import type { PrismaClient } from "./generated/prisma/client.ts"
import type { User } from "./types.ts"

type DbClient = PrismaClient

/**
 * The platform user behind a Neon Auth identity, creating it on first sight.
 *
 * Called on every authenticated request, so its cost is paid in front of
 * everything else on the page.
 *
 * ⚠️ **Read first, create only on a miss.** This was a `prisma.user.upsert`,
 * which on Postgres compiles to `INSERT … ON CONFLICT DO UPDATE` — a write
 * transaction and a WAL flush on every request, to maintain a mapping that is
 * immutable once created. The common case is now an index-only read on
 * `users_auth_user_id_key`.
 *
 * ⚠️ **The contract is idempotent and race-safe, not "one statement".** Two
 * concurrent first requests are normal: one loses the `INSERT` to the unique
 * index and re-reads what the winner wrote. A `null` on that re-read cannot
 * happen, so it re-throws the original violation. `stores.test.ts` drives it.
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
