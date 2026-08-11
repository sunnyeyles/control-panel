import type { PrismaClient } from "@workspace/db"
import { DevPrismaError } from "./fake-prisma/errors"
import { guard } from "./fake-prisma/guard"
import { createJobDelegate } from "./fake-prisma/jobs"
import { createRunDelegate } from "./fake-prisma/runs"
import { createPostingDelegate } from "./fake-prisma/postings"
import { createDocumentDelegate } from "./fake-prisma/documents"
import { createInstructionsDelegate } from "./fake-prisma/instructions"
import { createWhiteboardDelegate } from "./fake-prisma/whiteboard"
import { createPostingFiltersDelegate } from "./fake-prisma/posting-filters"
import { createDevStore } from "./fake-prisma/store"
import { executeRaw, queryRaw } from "./fake-prisma/raw-sql"

// Re-export public types and helpers
export type { PostingOrderBy } from "./fake-prisma/query-types"
export type { PostingWhere } from "./fake-prisma/query-types"
export {
  matchesPostingWhere,
  removeMatchingPostings,
} from "./fake-prisma/posting-where"
export {
  compareNullity,
  comparePostingValues,
} from "./fake-prisma/posting-order"

/**
 * Postgres, for `DEV_AUTH_BYPASS=1` only — an in-memory stand-in that honours
 * the queries this app makes and refuses every other one by name.
 *
 * **It filters and orders for real rather than returning canned rows**, so the
 * user-scoping in `lib/postings/list-postings.ts` and `job-actions.ts` stays
 * visible to anyone editing around it. Follows the `FakeDb` in
 * `lib/postings/list-postings.test.ts`.
 *
 * **Writes survive the process, not a restart.** A pause has to outlive the
 * redirect after it or the form looks broken; a restart restoring the fixtures
 * is the useful behaviour.
 *
 * ⚠️ **Unsupported calls throw** rather than answering `undefined` and
 * surfacing as a null dereference three frames away. See {@link guard}.
 */
export function createDevPrisma(): PrismaClient {
  const store = createDevStore()

  return guard({
    job: createJobDelegate(store),
    run: createRunDelegate(store),
    posting: createPostingDelegate(store),
    document: createDocumentDelegate(store),
    coverLetterInstructions: createInstructionsDelegate(store),
    postingFilters: createPostingFiltersDelegate(store),
    board: createWhiteboardDelegate(store),
    /**
     * Unreachable — `getCurrentUser()` returns before `ensureUserForAuth`.
     * Present so that moving that branch fails here, named, rather than as
     * "upsert is not a function".
     */
    user: {
      upsert: async () => {
        throw new DevPrismaError(
          "user.upsert",
          "Nothing should map an auth id onto a platform user under DEV_AUTH_BYPASS — the dev user's id is fixed in lib/dev/fixtures.ts."
        )
      },
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      executeRaw(store, strings, values),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      queryRaw(store, strings, values),
    $connect: async () => {},
    $disconnect: async () => {},
  }) as unknown as PrismaClient
}
