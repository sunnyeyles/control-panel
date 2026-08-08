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

/**
 * Where the fake's rows live under `DEV_AUTH_BYPASS=1`.
 *
 * ⚠️ **On `globalThis`, and it has to be.** Next evaluates this module more
 * than once in a single dev process — a route handler and a page get separate
 * instances of it — so a module-level `let` gives the fake one set of rows per
 * *bundle* rather than per process. Nothing noticed while every write went
 * through a Server Action, because an action and a page share a graph; the
 * whiteboard was the first feature to write from a route handler and read from
 * a page, and its board saved to one instance and loaded from the other, so it
 * silently never persisted.
 *
 * The real client is deliberately left on the module-level `let` above. It is a
 * connection pool, its correctness does not depend on being one object, and a
 * global would be a lifetime nobody asked for in production.
 */
const DEV_PRISMA_KEY = Symbol.for("@workspace/dashboard.devPrisma")

type DevPrismaGlobal = typeof globalThis & {
  [DEV_PRISMA_KEY]?: PrismaClient
}

function getDevPrisma(): PrismaClient {
  const store = globalThis as DevPrismaGlobal
  // `createPrismaClient()` is never called on this path, so `DATABASE_URL` is
  // never read.
  store[DEV_PRISMA_KEY] ??= createDevPrisma()
  return store[DEV_PRISMA_KEY]
}

export function getPrisma(): PrismaClient {
  // The fake keeps one set of rows per process, so a briefing paused on
  // /jobs/schedules reads as paused on /jobs — see `getDevPrisma`.
  if (devMockEnabled()) return getDevPrisma()

  // Memoized rather than per request: `createPrismaClient()` opens a pool, and
  // a serverless instance handling many requests should reuse it.
  prisma ??= createPrismaClient()
  return prisma
}
