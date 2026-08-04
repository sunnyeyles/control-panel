import { createDevPrisma } from "@/lib/dev/fake-prisma"
import { devMockEnabled } from "@/lib/dev/mode"
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
  // Memoized through the same variable, so the fake's rows are one set per
  // process — a briefing paused on /settings reads as paused on /briefings.
  // `createPrismaClient()` is never called, so `DATABASE_URL` is never read.
  prisma ??= devMockEnabled() ? createDevPrisma() : createPrismaClient()
  return prisma
}
