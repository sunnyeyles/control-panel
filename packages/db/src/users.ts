import type { PrismaClient } from "./generated/prisma/client.ts"
import type { User } from "./types.ts"

type DbClient = PrismaClient

/**
 * The platform user behind a Neon Auth identity, creating it on first sight.
 *
 * Called on every authenticated request, so it has to be idempotent and it has
 * to be one statement — two concurrent first requests for the same identity are
 * the normal case. The `update` writes the same value back so a conflict still
 * returns a row (Prisma upsert requires an update clause).
 */
export async function ensureUserForAuth(
  prisma: DbClient,
  authUserId: string
): Promise<User> {
  return prisma.user.upsert({
    where: { authUserId },
    create: { authUserId },
    update: { authUserId },
  })
}
