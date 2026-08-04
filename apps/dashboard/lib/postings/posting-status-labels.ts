import type { PostingStatus } from "@workspace/db"

/**
 * What each Posting status is called in the interface.
 *
 * ⚠️ **The import is `import type`, and that is load-bearing.** This map is
 * reached from the table and, once the status control lands, from a client
 * component; `@workspace/db` carries the Prisma client and `pg`. A type-only
 * import is erased before bundling, so three strings cost the browser nothing
 * while `satisfies Record<PostingStatus, string>` still makes the compiler
 * prove the set is exhaustive — which is the whole point. Importing the runtime
 * `POSTING_STATUSES` would single-source the values and put a database driver
 * in the bundle to do it.
 *
 * The same reasoning, at more length, is in
 * `lib/documents/document-type-labels.ts`.
 */
export const POSTING_STATUS_LABELS = {
  new: "New",
  applied: "Applied",
  rejected: "Rejected",
} satisfies Record<PostingStatus, string>
