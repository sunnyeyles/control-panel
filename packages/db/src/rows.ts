/**
 * The shape of what the four tables hold, as hand-written TypeScript.
 *
 * Hand-written rather than generated, because generation needs a live database
 * in the loop of a typecheck, and the schema is four tables. They are plain
 * interfaces on purpose: an ORM arriving later will want to own row types
 * itself, and an interface is the cheapest thing to delete.
 *
 * Columns are snake_case in Postgres and camelCase here. The mapping happens in
 * exactly one place per table — the `to…` functions beside each store — so a
 * renamed column is a compile error in one file.
 */

/** Anything the pipeline puts on a job. The platform never reads inside it. */
export type JobConfig = Record<string, unknown>

/**
 * Per-source failure detail, or the warnings from a run that otherwise
 * succeeded. Pipeline-shaped; the dashboard renders it, nothing queries into
 * it.
 */
export type RunFailure = Record<string, unknown>

/**
 * `running` → `succeeded` | `failed`, and both are terminal. That is the whole
 * graph.
 *
 * There is no `pending`, because the claim creates the row and starts the run
 * in one transaction. No `timed_out`, because a stuck run is already `running`
 * with an old `started_at` and would need the same sweep either way. No
 * `cancelled`, because nothing can cancel a run yet — and `text` + `CHECK`
 * makes adding it a one-line migration when something can.
 *
 * "Succeeded with warnings" is not a status. It is `succeeded` with a non-empty
 * `failure`, so the fact lives in one place and cannot disagree with itself.
 */
export type RunStatus = "running" | "succeeded" | "failed"

export interface User {
  id: string
  createdAt: Date
}

/**
 * A Gmail account this platform holds read access to (see CONTEXT.md).
 *
 * Deliberately without the refresh token: this is what `mailboxes.get()`
 * returns and what Settings renders, and the page that renders connection
 * state must not be *able* to hold the credential. The token has its own
 * accessor, `mailboxes.refreshToken()`.
 */
export interface Mailbox {
  id: string
  userId: string
  /** Which Google account is connected — shown so a wrong-account grant is visible. */
  emailAddress: string
  /** Exactly as Google echoed it in the token response, never as we asked. */
  scope: string
  /** Rewritten on every reconnect, not preserved from the first one. */
  connectedAt: Date
  /**
   * When a refresh came back `invalid_grant`; `null` means healthy. Names no
   * cause on purpose — Google reports every failure identically.
   */
  lapsedAt: Date | null
}

export interface Job {
  id: string
  userId: string
  name: string
  config: JobConfig
  /** The source of truth for cadence. Postgres owns this, not Terraform. */
  scheduleCron: string
  /** An IANA zone name. */
  scheduleTimezone: string
  /**
   * When the tick should next pick this job up.
   *
   * `null` means **not scheduled**, covering both paused and retired — which is
   * why there is no `enabled` flag and no `retired_at`.
   */
  nextRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * A job the tick has selected, narrowed so `nextRunAt` is known present.
 *
 * `claim()` takes this rather than a `Job` because the value it advances *from*
 * is the occurrence it claims — a claim without one is not expressible.
 */
export interface DueJob extends Job {
  nextRunAt: Date
}

export interface Run {
  id: string
  jobId: string
  /**
   * The slot this run occupies, read from the `next_run_at` the claim observed.
   *
   * `null` means ad-hoc. This is also the manual/scheduled test — there is no
   * `is_manual` column, because a second column encoding the same fact could
   * disagree with this one.
   */
  scheduledFor: Date | null
  status: RunStatus
  startedAt: Date
  /** `null` while running. The sole in-flight marker. */
  finishedAt: Date | null
  failure: RunFailure | null
}

export interface Artifact {
  id: string
  runId: string
  /** An S3 object key. Never a URL, never content — the CHECK enforces it. */
  objectKey: string
  createdAt: Date
}
