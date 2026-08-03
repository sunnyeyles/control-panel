import { createPrismaClient, type PrismaClient } from "@workspace/db"

/**
 * The dashboard's Prisma Client, one per server instance.
 *
 * Memoized rather than constructed per request: `createPrismaClient()` opens a
 * pool via the driver adapter, and a serverless instance that handles many
 * requests should reuse it. Still a function rather than a module-level
 * `const` — constructing it reads `DATABASE_URL`, and the repo's rule is that
 * configuration is read when something asks for it, not at import time.
 *
 * Import the package barrel rather than a migrate path: migrate tooling lives
 * under `prisma/` and is never pulled into the Next bundle from this module.
 */
let prisma: PrismaClient | undefined

export function getPrisma(): PrismaClient {
  prisma ??= createPrismaClient()
  return prisma
}
