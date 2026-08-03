import { PrismaPg } from "@prisma/adapter-pg"

import { readDatabaseConfig, type DatabaseConfig } from "./config.ts"
import { PrismaClient } from "./generated/prisma/client.ts"

/**
 * The only module that constructs a Prisma Client.
 *
 * A factory and never a module-level instance: constructing this reads
 * configuration, so an instance at module scope would move that failure to
 * *import* time — the same rule that governs `createAgent()` and
 * `createS3UserObjectStore()`.
 *
 * Runtime uses the **pooled** `DATABASE_URL`. Migrations use the direct
 * endpoint via `prisma.config.ts` and never go through this factory.
 */
export function createPrismaClient(
  config: DatabaseConfig = readDatabaseConfig()
): PrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: config.connectionString,
      // Unqualified raw SQL (`$queryRaw` / `$executeRaw`) resolves through
      // search_path. The integration suite pins a throwaway schema; without
      // this, Prisma model queries hit that schema while raw SQL hits public.
      ...(config.schema ? { options: `-c search_path=${config.schema}` } : {}),
    },
    // Rewrites generated SQL to `"schema"."table"`. Needed because Prisma
    // otherwise qualifies tables as `"public"."…"`, ignoring search_path.
    config.schema ? { schema: config.schema } : undefined
  )
  return new PrismaClient({ adapter })
}

export type { PrismaClient }
