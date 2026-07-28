/**
 * Postgres for scheduling and provenance — jobs, their runs, and pointers to
 * what those runs produced.
 *
 * Compose it once, per invocation, at the composition root:
 *
 * ```ts
 * const db = createDb()
 * try {
 *   for (const job of await db.jobs.dueJobs()) {
 *     const slot = await db.jobs.claim(job)
 *     if (!slot) continue          // someone else has it — skip entirely
 *     // …run it…
 *     await db.runs.finish(slot.runId)
 *   }
 * } finally {
 *   await db.close()
 * }
 * ```
 *
 * Everything downstream should take a `JobStore`, `RunStore` or `ArtifactStore`
 * as a parameter. That is what keeps every line of SQL — and the `pg` import —
 * inside this package, which is the whole reason an ORM can still be chosen
 * later without touching a single caller.
 *
 * Individual modules are importable directly:
 * `@workspace/db/schedule` gets `computeNextRunAt` without pulling in the
 * driver at all.
 */
export { createDb, type Db } from "./db.ts"

export {
  readDatabaseConfig,
  readMigrationConfig,
  DATABASE_URL,
  DATABASE_URL_UNPOOLED,
  type DatabaseConfig,
} from "./config.ts"

export { createUserStore, type UserStore } from "./users.ts"

export {
  createJobStore,
  type ClaimedSlot,
  type JobStore,
  type NewJob,
} from "./jobs.ts"

export { createRunStore, type RunStore } from "./runs.ts"

export { createArtifactStore, type ArtifactStore } from "./artifacts.ts"

export { computeNextRunAt, isValidSchedule } from "./schedule.ts"

export {
  appliedMigrations,
  runMigrations,
  type MigrationsResult,
  type RunMigrationsOptions,
} from "./migrate.ts"

export type {
  Artifact,
  DueJob,
  Job,
  JobConfig,
  Run,
  RunFailure,
  RunStatus,
  User,
} from "./rows.ts"

export {
  DatabaseUnavailableError,
  DbError,
  InvalidScheduleError,
  isDbError,
  MigrationError,
  type DbErrorCode,
} from "./errors.ts"
