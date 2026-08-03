import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { config as loadEnv } from "dotenv"
import { defineConfig } from "prisma/config"

/**
 * Prisma CLI config. Migrations and other CLI commands use the **direct**
 * (unpooled) Neon endpoint — PgBouncer in transaction mode does not carry the
 * session state migrate needs.
 *
 * Runtime queries use the pooled `DATABASE_URL` via the driver adapter in
 * `src/client.ts`. That split is load-bearing; do not point this file at the
 * pooler.
 *
 * `prisma generate` does not connect, so a placeholder is enough when the env
 * var is unset (typecheck/build without credentials). `migrate deploy` still
 * requires a real `DATABASE_URL_UNPOOLED`.
 */
const packageRoot = dirname(fileURLToPath(import.meta.url))
const envFile = join(packageRoot, ".env.local")

if (existsSync(envFile)) {
  loadEnv({ path: envFile, quiet: true })
}

const directUrl =
  process.env.DATABASE_URL_UNPOOLED?.trim() ||
  "postgresql://postgres:postgres@localhost:5432/postgres"

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: directUrl,
  },
})
