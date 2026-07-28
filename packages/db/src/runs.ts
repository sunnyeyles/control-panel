import type { Connection } from "./client.ts"
import type { Run, RunFailure, RunStatus } from "./rows.ts"

/**
 * Runs, and the two statements that end one.
 *
 * There is no `start()` for a scheduled run — that is `JobStore.claim()`, which
 * creates the row and takes the slot in one transaction. The only run this
 * store starts is an ad-hoc one, which by definition occupies no slot.
 */
export interface RunStore {
  /**
   * Begin a run with no scheduled occurrence.
   *
   * Unconstrained on purpose: Postgres treats NULLs as distinct inside a unique
   * index, so ad-hoc runs never collide with each other while scheduled slots
   * stay unique. No `NULLS NOT DISTINCT`, which would silently cap this at one
   * manual run per job forever.
   */
  startAdHoc(jobId: string): Promise<Run>

  /**
   * Mark a run succeeded. `false` means it was already terminal.
   *
   * `warnings` is how partial success is recorded — one failing scraper should
   * not fail the whole job, so that run is `succeeded` with a non-empty
   * `failure`. A fourth status would encode the same fact twice.
   */
  finish(runId: string, warnings?: RunFailure): Promise<boolean>

  /** Mark a run failed. `false` means it was already terminal. */
  fail(runId: string, failure?: RunFailure): Promise<boolean>

  get(runId: string): Promise<Run | undefined>

  /** This job's runs, newest first — the dashboard's job detail view. */
  recent(jobId: string, limit?: number): Promise<Run[]>
}

interface RunRow {
  id: string
  job_id: string
  scheduled_for: Date | null
  status: RunStatus
  started_at: Date
  finished_at: Date | null
  failure: RunFailure | null
}

const COLUMNS = `id, job_id, scheduled_for, status, started_at, finished_at, failure`

const DEFAULT_RECENT_LIMIT = 20

export function createRunStore(connection: Connection): RunStore {
  /**
   * The transition guard, in one place.
   *
   * A `CHECK` validates a value and can never see the old row, so legality of
   * the *transition* has to live in a `WHERE`. Zero rows affected means the run
   * was already terminal — a lost race, not an error to retry — and a caller
   * that omitted this clause could walk a finished run back to `running`. It
   * is written once here precisely so no caller is in a position to omit it.
   */
  async function terminate(
    runId: string,
    status: Exclude<RunStatus, "running">,
    failure: RunFailure | undefined
  ): Promise<boolean> {
    const { rowCount } = await connection.query(
      `update runs set status = $2, finished_at = now(), failure = $3
       where id = $1 and status = 'running'`,
      [runId, status, failure ? JSON.stringify(failure) : null]
    )

    return rowCount > 0
  }

  return {
    async startAdHoc(jobId: string): Promise<Run> {
      const { rows } = await connection.query<RunRow>(
        `insert into runs (job_id, scheduled_for, status)
         values ($1, null, 'running')
         returning ${COLUMNS}`,
        [jobId]
      )

      const row = rows[0]
      if (!row) throw new Error("insert into runs returned no row")

      return toRun(row)
    },

    finish(runId: string, warnings?: RunFailure): Promise<boolean> {
      return terminate(runId, "succeeded", warnings)
    },

    fail(runId: string, failure?: RunFailure): Promise<boolean> {
      return terminate(runId, "failed", failure)
    },

    async get(runId: string): Promise<Run | undefined> {
      const { rows } = await connection.query<RunRow>(
        `select ${COLUMNS} from runs where id = $1`,
        [runId]
      )

      return rows[0] ? toRun(rows[0]) : undefined
    },

    async recent(
      jobId: string,
      limit: number = DEFAULT_RECENT_LIMIT
    ): Promise<Run[]> {
      const { rows } = await connection.query<RunRow>(
        `select ${COLUMNS} from runs
         where job_id = $1
         order by started_at desc
         limit $2`,
        [jobId, limit]
      )

      return rows.map(toRun)
    },
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    jobId: row.job_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failure: row.failure,
  }
}
