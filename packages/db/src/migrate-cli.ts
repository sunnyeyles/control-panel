import { runMigrations } from "./migrate.js"

/**
 * `pnpm --filter @workspace/db migrate`
 *
 * Deliberately thin, and deliberately not run at Lambda startup: migrating on
 * boot means every cold start races every other one for the schema, and the
 * advisory lock turns that race into a queue of invocations waiting on a
 * migration they do not need.
 *
 * Reads `DATABASE_URL_UNPOOLED` — the direct endpoint. Through the pooler the
 * session advisory lock would appear to be taken and would hold nothing.
 */
const result = await runMigrations({
  onApplied: (filename) => console.log(`applied ${filename}`),
})

console.log(
  result.applied.length > 0
    ? `${result.applied.length} migration(s) applied, ${result.skipped.length} already present.`
    : `Nothing to do — all ${result.skipped.length} migration(s) already applied.`
)
