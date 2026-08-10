import type { PostingStatus } from "@workspace/db"

/**
 * What each Posting status is called in the interface.
 *
 * ⚠️ **The import is `import type`, and that is load-bearing.** This map is
 * reached from the table and, once the status control lands, from a client
 * component; `@workspace/db` carries the Prisma client and `pg`. A type-only
 * import is erased before bundling, so four strings cost the browser nothing
 * while `satisfies Record<PostingStatus, string>` still makes the compiler
 * prove the set is exhaustive — which is the whole point. Importing the runtime
 * `POSTING_STATUSES` would single-source the values and put a database driver
 * in the bundle to do it.
 *
 * ⚠️ **This map is also the only exhaustiveness gate on `PostingStatus`.**
 * `POSTING_STATUSES` looks like one and is not: a short array still satisfies
 * `readonly PostingStatus[]`, so a member added to the union and missed there
 * compiles. Missed *here* it does not — which is why adding a status starts by
 * failing this file's typecheck.
 *
 * Insertion order is the order the select offers, because
 * `components/jobs/postings/posting-status-select.tsx` builds its options with
 * `Object.entries`. These four are in the order a person moves through them.
 *
 * The same reasoning, at more length, is in
 * `lib/documents/document-type-labels.ts`.
 */
export const POSTING_STATUS_LABELS = {
  new: "New",
  applied: "Applied",
  // The user's own decision not to apply, and deliberately not next to
  // `rejected`, which is the employer's answer to an application already sent.
  "not-interested": "Not interested",
  rejected: "Rejected",
} satisfies Record<PostingStatus, string>
