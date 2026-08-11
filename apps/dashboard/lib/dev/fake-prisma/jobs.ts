import type { Job } from "@workspace/db"
import { DevPrismaError, notFound } from "./errors.ts"
import type { DevStore } from "./store.ts"
import type { ById, FindManyJobs, JobCreateData } from "./query-types.ts"

export function createJobDelegate(store: DevStore) {
  return {
    findMany: async (query: FindManyJobs) => findManyJobs(store, query),
    findUnique: async (query: ById) => findJob(store, query.where.id),
    create: async (query: { data: JobCreateData }) =>
      createJob(store, query.data),
    update: async (query: ById & { data: Partial<Job> }) =>
      updateJob(store, query.where.id, query.data),
  }
}

/**
 * The whole rows, which is the only shape the dashboard asks for — both call
 * sites (`/jobs` and the settings section) select nothing.
 *
 * It used to answer a second shape too, `select: { runs: … }`, for the
 * deleted `lib/briefings/latest-postings.ts`, which read one Run's findings
 * to build the page. Nothing asks that now, so the branch is gone rather than
 * left answering a question nobody puts — and if a caller starts asking
 * again, guard is not what catches it: `select` would be accepted and
 * silently ignored, so the branch has to come back with the caller.
 *
 * `orderBy` is not read; every call site wants `createdAt` descending, which
 * is what this returns. The one place this fake lies rather than throwing —
 * cheap to fix if that changes. findManyPostings is deliberately not like
 * this: its order is chosen from the URL, so ignoring it there would be
 * a wrong-order bug rather than a shortcut.
 */
function findManyJobs(store: DevStore, query: FindManyJobs): Partial<Job>[] {
  const found = store.jobs
    .filter((job) => job.userId === query.where.userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  const select = query.select
  if (!select) return found

  return found.map((job) => projectJob(job, select))
}

/**
 * A Job narrowed to the fields a `select` asked for.
 *
 * The same rule as projectPosting, minus the relation branch: jobs are only
 * ever selected by column here. An unknown field throws by name rather than
 * answering `undefined`, so a select this fake cannot serve fails loudly
 * under `DEV_AUTH_BYPASS` instead of rendering a blank.
 */
function projectJob(job: Job, select: Record<string, boolean>): Partial<Job> {
  const projected: Record<string, unknown> = {}

  for (const [field, wanted] of Object.entries(select)) {
    if (!wanted) continue

    if (!(field in job)) {
      throw new DevPrismaError(
        `prisma.job.findMany select.${field}`,
        "That column is not on a Job. Add it to lib/dev/fixtures.ts, or fix the select in app/(app)/jobs/page.tsx."
      )
    }

    projected[field] = job[field as keyof Job]
  }

  return projected as Partial<Job>
}

export function findJob(store: DevStore, id: string): Job | null {
  return store.jobs.find((job) => job.id === id) ?? null
}

function createJob(store: DevStore, data: JobCreateData): Job {
  const now = new Date()
  const job: Job = {
    ...data,
    id: `3f8d1b2a-0000-4000-8000-${String(store.nextId++).padStart(12, "0")}`,
    createdAt: now,
    updatedAt: now,
  }

  store.jobs.push(job)
  return job
}

function updateJob(store: DevStore, id: string, data: Partial<Job>): Job {
  const job = findJob(store, id)

  // P2025 is the code `pauseJob()` in packages/db/src/jobs.ts catches to
  // return undefined for a row that is gone. A plain Error would propagate
  // past it and surface as "Something went wrong" instead of "not found".
  if (!job) throw notFound()

  Object.assign(job, data, { updatedAt: new Date() })
  return job
}
