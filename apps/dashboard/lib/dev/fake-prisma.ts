import type { PrismaClient } from "@workspace/db"
import { DevPrismaError } from "./fake-prisma/errors"
import { guard } from "./fake-prisma/guard"
import { createDocumentDelegate } from "./fake-prisma/documents"
import { createWhiteboardDelegate } from "./fake-prisma/whiteboard"
import { createDevStore } from "./fake-prisma/store"

/**
 * Postgres, for `DEV_AUTH_BYPASS=1` only — an in-memory stand-in that honours
 * the queries this app makes and refuses every other one by name.
 *
 * **It filters and orders for real rather than returning canned rows**, so the
 * user-scoping in `@workspace/db`'s document helpers stays visible to anyone
 * editing around it.
 *
 * **Writes survive the process, not a restart.** An upload has to outlive the
 * refresh after it or the form looks broken; a restart restoring the fixtures
 * is the useful behaviour.
 *
 * ⚠️ **Unsupported calls throw** rather than answering `undefined` and
 * surfacing as a null dereference three frames away. See {@link guard}.
 */
export function createDevPrisma(): PrismaClient {
  const store = createDevStore()

  return guard({
    document: createDocumentDelegate(store),
    board: createWhiteboardDelegate(store),
    /**
     * Unreachable — `getCurrentUser()` returns before `ensureUserForAuth`.
     * Present so that moving that branch fails here, named, rather than as
     * "findUnique is not a function".
     */
    user: {
      findUnique: async () => {
        throw new DevPrismaError(
          "user.findUnique",
          "Nothing should map an auth id onto a platform user under DEV_AUTH_BYPASS — the dev user's id is fixed in lib/dev/fixtures.ts."
        )
      },
    },
    $connect: async () => {},
    $disconnect: async () => {},
  }) as unknown as PrismaClient
}
