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
