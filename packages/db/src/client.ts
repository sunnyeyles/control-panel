import pg from "pg"

import type { DatabaseConfig } from "./config.js"
import { DatabaseUnavailableError } from "./errors.js"

/**
 * The only file in the repository that imports a Postgres driver.
 *
 * That is the seam. `@workspace/user-storage` keeps `@aws-sdk/client-s3` to one
 * module so the storage backend stays replaceable; this is the same move for
 * the same reason. Adopting a query builder later rewrites this file and the
 * SQL strings in the stores beside it, and touches no caller — which is the
 * whole point of there being no generic query surface.
 *
 * Everything above this file talks to {@link Queryable}, never to `pg`.
 */

/** What a statement gives back. Deliberately narrower than `pg.QueryResult`. */
export interface QueryResult<Row> {
  rows: Row[]
  /**
   * Rows affected. The guard clauses in this package's stores read this and
   * nothing else — "zero rows means someone else got there first" is the one
   * concurrency idiom here.
   */
  rowCount: number
}

/**
 * Anything statements can be sent to: the connection itself, or a transaction
 * handle inside it. The stores take this rather than a connection, so a query
 * written for the outside of a transaction works unchanged inside one.
 */
export interface Queryable {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<Row>>
}

/** One connection to Postgres, and the transactions run over it. */
export interface Connection extends Queryable {
  /**
   * Run `fn` inside `BEGIN`/`COMMIT`, rolling back if it throws.
   *
   * The claim needs this: advancing `next_run_at` and inserting the run row
   * must either both happen or neither, or a tick can move a job forward
   * without recording that it ran.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>

  /** Close the socket. Always call it; see the note on {@link createConnection}. */
  close(): Promise<void>
}

/**
 * Open one connection, lazily.
 *
 * **One `Client` per invocation, closed at the end — no module-scope reuse and
 * no pool above one.** On Lambda the gap between invocations is an hour and
 * Neon autosuspends after five minutes, so a cached socket is dead by the next
 * invocation as the *default* outcome rather than as an edge case. Reconnecting
 * every time is not a cost being paid reluctantly; it is the only thing that
 * works.
 *
 * Vercel is the opposite case and gets the opposite treatment — many short
 * concurrent invocations against the pooled endpoint — but that is which
 * connection string is passed in, not a second code path.
 *
 * Connecting is deferred to the first statement so that `createDb()` cannot
 * fail on a database that is merely asleep, and so a code path that never
 * queries never opens a socket.
 */
export function createConnection(config: DatabaseConfig): Connection {
  const client = new pg.Client({ connectionString: config.connectionString })

  let connecting: Promise<void> | undefined
  let closed = false

  async function ready(): Promise<void> {
    if (closed) {
      throw new DatabaseUnavailableError(
        "This connection is already closed. createDb() produces one connection per invocation; make another."
      )
    }

    // Assigned before it is awaited, so two concurrent first statements share
    // one connect rather than racing into `Client already connected`.
    connecting ??= client.connect().then(
      () => undefined,
      (cause: unknown) => {
        // Let the next attempt try again rather than caching the rejection
        // forever — a cold Neon compute can refuse the first connect while it
        // wakes.
        connecting = undefined
        throw new DatabaseUnavailableError(reasonFor(cause), { cause })
      }
    )

    await connecting
  }

  const connection: Connection = {
    async query<Row extends object = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = []
    ): Promise<QueryResult<Row>> {
      await ready()

      try {
        // Parameters are passed only when there are some, and that is
        // load-bearing rather than tidiness: handing `pg` a values array puts
        // the statement on the extended query protocol, which permits exactly
        // one statement per call. The migration runner sends whole `.sql` files
        // — many statements, no parameters — and they only work on the simple
        // protocol this takes for a parameterless call.
        const result =
          params.length > 0
            ? await client.query<Row>(sql, [...params])
            : await client.query<Row>(sql)
        // `rowCount` is null for statements that return no count at all
        // (`BEGIN`, `SET`). Nothing in this package branches on those, but a
        // null leaking into a `=== 0` guard would read as "someone else won the
        // race" and silently skip a job.
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      } catch (cause) {
        // Constraint violations are the caller's business and must keep their
        // Postgres error code — the CHECK on `object_key` is a real result, not
        // an outage. Only the connection failing is remapped.
        throw isConnectionFault(cause)
          ? new DatabaseUnavailableError(reasonFor(cause), { cause })
          : cause
      }
    },

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      await connection.query("begin")

      try {
        const result = await fn(connection)
        await connection.query("commit")
        return result
      } catch (error) {
        // Best-effort: if the rollback itself fails the connection is gone, and
        // the original error is the one worth surfacing.
        await connection.query("rollback").catch(() => undefined)
        throw error
      }
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      if (!connecting) return

      // `end()` on a client whose connect rejected throws again; the connection
      // is gone either way, which is what close() was asked for.
      await client.end().catch(() => undefined)
    },
  }

  return connection
}

/**
 * Faults that mean "the database is unreachable" rather than "the statement was
 * wrong". Class 08 is Postgres's own connection-exception family; the Node
 * codes cover the socket never getting that far.
 */
function isConnectionFault(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const code = (error as { code?: unknown }).code

  return (
    typeof code === "string" &&
    (code.startsWith("08") ||
      code === "57P01" || // admin_shutdown — Neon suspending under us
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE")
  )
}

function reasonFor(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)

  // The connection string is not in the message and must not be added to it —
  // it carries the password.
  return `Could not reach Postgres: ${detail}`
}
