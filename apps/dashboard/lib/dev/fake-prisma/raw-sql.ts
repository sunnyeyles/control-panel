import type { Run } from "@workspace/db"
import { DevPrismaError } from "./errors"
import { byStartedAtThenIdDesc } from "./posting-order"
import type { DevStore } from "./store"

/**
 * ⚠️ **`updateJobSchedule()` is raw SQL, not `job.update`** — it needs a
 * `CASE` to leave a paused briefing paused — so the schedule form lands here
 * and its four values are matched by position.
 *
 * Fragile, so it is checked rather than assumed: anything that is not an
 * `UPDATE jobs` with four values throws, naming the file to look at.
 */
export function executeRaw(
  store: DevStore,
  strings: TemplateStringsArray,
  values: unknown[]
): number {
  const sql = strings.join("?")

  if (!/update\s+jobs/i.test(sql) || values.length !== 4) {
    throw new DevPrismaError(
      "$executeRaw",
      `Only the UPDATE in updateJobSchedule() is understood, and it is ` +
        `matched by position. If packages/db/src/jobs.ts changed its ` +
        `statement, update executeRaw() in this file to match. Got: ${sql}`
    )
  }

  const [cron, timezone, nextRunAt, id] = values as [
    string,
    string,
    Date,
    string,
  ]

  const job = store.jobs.find((j) => j.id === id)
  if (!job) return 0

  job.scheduleCron = cron
  job.scheduleTimezone = timezone
  // The `CASE` in the real statement: a paused briefing stays paused.
  job.nextRunAt = job.nextRunAt === null ? null : nextRunAt
  job.updatedAt = new Date()

  return 1
}

/**
 * ⚠️ **`latestRunPerJob()` is raw SQL, not `run.findMany`** — it needs
 * `DISTINCT ON`, which Prisma's model API cannot express — so the briefings
 * page lands here.
 *
 * Recognised by shape rather than parsed, exactly as executeRaw is,
 * and it throws on anything else so a changed statement fails by name instead
 * of silently returning nothing and rendering an empty page.
 */
export function queryRaw(
  store: DevStore,
  strings: TemplateStringsArray,
  values: unknown[]
): unknown[] {
  const sql = strings.join("?")

  if (
    !/distinct\s+on\s*\(\s*r\.job_id\s*\)/i.test(sql) ||
    values.length !== 1
  ) {
    throw new DevPrismaError(
      "$queryRaw",
      `Only the DISTINCT ON in latestRunPerJob() is understood, and it is ` +
        `matched by shape. If packages/db/src/runs.ts changed its ` +
        `statement, update queryRaw() in this file to match. Got: ${sql}`
    )
  }

  const [userId] = values as [string]
  const mine = new Set(
    store.jobs.filter((job) => job.userId === userId).map((job) => job.id)
  )

  const newest = new Map<string, Run>()
  for (const run of [...store.runs].sort(byStartedAtThenIdDesc)) {
    if (mine.has(run.jobId) && !newest.has(run.jobId))
      newest.set(run.jobId, run)
  }

  return [...newest.values()].map((run) => ({
    id: run.id,
    jobId: run.jobId,
    status: run.status,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    failure: run.failure,
  }))
}
