import { createDevPrisma } from "@/lib/dev/fake-prisma"
import { devMockEnabled } from "@/lib/dev/mode"
import { createPrismaClient, type PrismaClient } from "@workspace/db"

/**
 * The dashboard's Prisma Client, one per server instance.
 *
 * A function rather than a module-level `const` — constructing it reads
 * `DATABASE_URL`, and the repo's rule is that configuration is read when
 * something asks for it, not at import time. Import the package barrel, never a
 * migrate path: that tooling must not be pulled into the Next bundle.
 */
let prisma: PrismaClient | undefined

/**
 * Where the fake's rows live under `DEV_AUTH_BYPASS=1`.
 *
 * ⚠️ **On `globalThis`, and it has to be.** Next evaluates this module more than
 * once in a dev process — a route handler and a page get separate instances — so
 * a module-level `let` gives the fake one set of rows per *bundle*. Nothing
 * noticed while every write went through a Server Action, which shares a graph
 * with the page; the whiteboard wrote from a route handler and read from a page,
 * and silently never persisted.
 *
 * The real client stays on the module-level `let` above: it is a connection
 * pool, its correctness does not depend on being one object, and a global would
 * be a lifetime nobody asked for in production.
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
  if (devMockEnabled()) return getDevPrisma()

  // Memoized rather than per request: `createPrismaClient()` opens a pool, and
  // a serverless instance handling many requests should reuse it.
  prisma ??= createPrismaClient()
  return prisma
}
