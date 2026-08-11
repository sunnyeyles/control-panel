import type { Run } from "@workspace/db"
import { notFound } from "./errors"
import { byStartedAtThenIdDesc } from "./posting-order"
import type { DevStore } from "./store"
import type { ById, RunCreateData, RunningRunQuery } from "./query-types"

export function createRunDelegate(store: DevStore) {
  return {
    findFirst: async (query: RunningRunQuery) => findRunningRun(store, query),
    create: async (query: { data: RunCreateData }) =>
      createRun(store, query.data),
    update: async (query: ById & { data: Partial<Run> }) =>
      updateRun(store, query.where.id, query.data),
    updateMany: async (query: {
      where: { id: string; status?: string }
      data: Partial<Run>
    }) => updateRunsGuarded(store, query.where, query.data),
  }
}

/** The trigger's one-run-at-a-time guard, filtering for real. */
function findRunningRun(store: DevStore, query: RunningRunQuery): Run | null {
  const { jobId, status, startedAt } = query.where

  return (
    store.runs
      .filter(
        (run) =>
          run.jobId === jobId &&
          run.status === status &&
          run.startedAt.getTime() >= startedAt.gte.getTime()
      )
      .sort(byStartedAtThenIdDesc)[0] ?? null
  )
}

function createRun(store: DevStore, data: RunCreateData): Run {
  const run: Run = {
    ...data,
    id: `3f8d1b2a-0000-4000-8000-${String(store.nextId++).padStart(12, "0")}`,
    startedAt: new Date(),
    claimedAt: null,
    finishedAt: null,
    failure: null,
    findings: null,
  }

  store.runs.push(run)
  return run
}

function updateRun(store: DevStore, id: string, data: Partial<Run>): Run {
  const run = store.runs.find((candidate) => candidate.id === id)
  if (!run) throw notFound()

  Object.assign(run, data)
  return run
}

/**
 * `updateMany` with the row count as the answer — the shape `finishRun()` and
 * `failRun()` use to make a transition at-most-once. The `status` in the
 * `where` is the guard, so honouring it is what keeps a terminal run
 * terminal here too.
 */
function updateRunsGuarded(
  store: DevStore,
  where: { id: string; status?: string },
  data: Partial<Run>
): { count: number } {
  const run = store.runs.find(
    (candidate) =>
      candidate.id === where.id &&
      (where.status === undefined || candidate.status === where.status)
  )

  if (!run) return { count: 0 }

  Object.assign(run, data)
  return { count: 1 }
}
