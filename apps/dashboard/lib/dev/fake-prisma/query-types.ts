/**
 * How the Documents table is addressed: by owner, and by owner plus id.
 *
 * **`userId` is not optional and must not become so.** It is the entire
 * ownership check on both `findDocument` and `deleteDocument` — there is no
 * second one underneath, the way `assertOwnedBy` sits under the object store.
 */
export interface DocumentWhere {
  userId: string
  id?: string
}

export interface DocumentsForUser {
  where: { userId: string }
  orderBy?: unknown
}

/** How the one row-per-user table is addressed: its owner *is* its primary key. */
export interface ByUserId {
  where: { userId: string }
}

export interface UpsertBoard extends ByUserId {
  create: { userId: string; snapshot: unknown }
  update: { snapshot: unknown }
}
