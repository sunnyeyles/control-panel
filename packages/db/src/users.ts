import type { Connection } from "./client.ts"
import type { User } from "./rows.ts"

/**
 * Users, and deliberately almost nothing about them.
 *
 * The row exists because a job needs an owner and because the id becomes the
 * `userId` segment of every S3 key that user owns — a segment that is the
 * ownership boundary, not a naming convention. Email, display name and
 * credentials belong to the authentication effort and are absent on purpose.
 *
 * There is no `delete()`. `on delete restrict` runs through the whole schema,
 * so removing a user who owns jobs fails loudly rather than silently erasing
 * their provenance; erasure is a deliberate operation this package does not
 * pretend to offer yet.
 */
export interface UserStore {
  create(): Promise<User>
  get(id: string): Promise<User | undefined>
  /**
   * The platform user behind a Neon Auth identity, creating it on first sight.
   *
   * Called on every authenticated request, so it has to be idempotent and it
   * has to be one statement — two concurrent first requests for the same
   * identity are the normal case, not the edge one, and a select-then-insert
   * would let both selects miss.
   *
   * There is no transaction to coordinate with: Neon Auth has already created
   * the account upstream by the time this runs, so the only thing that can fail
   * is this insert, and failing it just means the caller retries on the next
   * request.
   */
  ensureForAuthUser(authUserId: string): Promise<User>
}

interface UserRow {
  id: string
  created_at: Date
}

export function createUserStore(connection: Connection): UserStore {
  return {
    async create(): Promise<User> {
      const { rows } = await connection.query<UserRow>(
        "insert into users default values returning id, created_at"
      )

      const row = rows[0]
      if (!row) throw new Error("insert into users returned no row")

      return { id: row.id, createdAt: row.created_at }
    },

    async ensureForAuthUser(authUserId: string): Promise<User> {
      // The `do update` is a no-op that writes back the value already there.
      // It exists because `do nothing` returns no row on conflict, which would
      // force a second round trip on every request after the first.
      const { rows } = await connection.query<UserRow>(
        `insert into users (auth_user_id) values ($1)
         on conflict (auth_user_id) do update set auth_user_id = excluded.auth_user_id
         returning id, created_at`,
        [authUserId]
      )

      const row = rows[0]
      if (!row) throw new Error("upsert into users returned no row")

      return { id: row.id, createdAt: row.created_at }
    },

    async get(id: string): Promise<User | undefined> {
      const { rows } = await connection.query<UserRow>(
        "select id, created_at from users where id = $1",
        [id]
      )

      const row = rows[0]
      return row ? { id: row.id, createdAt: row.created_at } : undefined
    },
  }
}
