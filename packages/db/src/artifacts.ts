import type { Connection } from "./client.ts"
import type { Artifact } from "./rows.ts"

/**
 * Pointers to what a run produced.
 *
 * An object key and nothing else — no kind, no URL, no bytes. The key already
 * encodes `environment/userId/kind/…`, and `parseObjectKey()` in
 * `@workspace/user-storage` recovers all three. That is why this package does
 * not depend on that one: to Postgres the key is opaque text, so the arrow
 * between the two is never drawn in either direction.
 */
export interface ArtifactStore {
  /**
   * Record an object key against a run.
   *
   * The `CHECK` on the column rejects anything with a URL scheme or a leading
   * slash, so a `https://…` handed to this method fails at the database rather
   * than becoming a row the whole system misreads as a key.
   */
  record(runId: string, objectKey: string): Promise<Artifact>

  /** Everything one run produced, oldest first. */
  forRun(runId: string): Promise<Artifact[]>

  /**
   * The most recent artifact from a successful run of this job — what the
   * dashboard shows as "the latest brief".
   */
  latestForJob(jobId: string): Promise<Artifact | undefined>
}

interface ArtifactRow {
  id: string
  run_id: string
  object_key: string
  created_at: Date
}

const COLUMNS = `id, run_id, object_key, created_at`

export function createArtifactStore(connection: Connection): ArtifactStore {
  return {
    async record(runId: string, objectKey: string): Promise<Artifact> {
      const { rows } = await connection.query<ArtifactRow>(
        `insert into artifacts (run_id, object_key)
         values ($1, $2)
         returning ${COLUMNS}`,
        [runId, objectKey]
      )

      const row = rows[0]
      if (!row) throw new Error("insert into artifacts returned no row")

      return toArtifact(row)
    },

    async forRun(runId: string): Promise<Artifact[]> {
      const { rows } = await connection.query<ArtifactRow>(
        `select ${COLUMNS} from artifacts
         where run_id = $1
         order by created_at asc`,
        [runId]
      )

      return rows.map(toArtifact)
    },

    async latestForJob(jobId: string): Promise<Artifact | undefined> {
      // Joined rather than denormalised onto the artifact row. `runs` is
      // reached by `runs_job_started_at_idx` and `artifacts` by
      // `artifacts_run_id_idx`, which is what that second index is for —
      // Postgres does not index the referencing side of a foreign key.
      const { rows } = await connection.query<ArtifactRow>(
        `select a.id, a.run_id, a.object_key, a.created_at
         from artifacts a
         join runs r on r.id = a.run_id
         where r.job_id = $1 and r.status = 'succeeded'
         order by r.started_at desc, a.created_at desc
         limit 1`,
        [jobId]
      )

      return rows[0] ? toArtifact(rows[0]) : undefined
    },
  }
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    objectKey: row.object_key,
    createdAt: row.created_at,
  }
}
