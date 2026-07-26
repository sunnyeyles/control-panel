import "dotenv/config"

import { defineConfig } from "drizzle-kit"

const url = process.env.DATABASE_URL

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Add it to packages/db/.env before running " +
      "drizzle-kit commands."
  )
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
