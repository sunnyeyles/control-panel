import type { ComponentProps } from "react"

import { POSTING_STATUS_LABELS } from "@/lib/postings/posting-status-labels"
import type { PostingStatus } from "@workspace/db"
import { Badge } from "@workspace/ui/components/badge"

/**
 * How each status is drawn, so twenty-five of them read as a column rather than
 * as twenty-five announcements.
 *
 * ⚠️ **`new` is `outline` because it is the majority, not because it is
 * unimportant.** Every Posting starts there and most stay there, so a filled
 * badge on every row would be the loudest thing on the page — louder than the
 * Match column, which is the cell the table is actually scanned for. The ones
 * that mean somebody *did* something are what stand out against it.
 *
 * `destructive` is already the muted `bg-destructive/10` treatment rather than
 * solid red — see `packages/ui/src/components/badge.tsx`. A rejection is
 * information, not an error.
 *
 * ⚠️ **`not-interested` is the one status drawn quieter than `new`, and that
 * inverts the rule above on purpose.** It is a decision like `applied` is, but
 * it is the decision to stop reading the row — so `ghost`, which draws the
 * label with no chip around it at all, is the only variant that lets a passed-on
 * advertisement recede while still saying which state it is in. Weighting it
 * like `applied` would give the column its loudest mark for the rows the user
 * has finished with. See {@link PostingStatus} in `@workspace/db` for why the
 * two are a pair despite looking nothing alike here.
 *
 * ⚠️ **`secondary` is deliberately unused here**, though it would suit `new`:
 * the Source column two cells to the left renders a `secondary` badge on every
 * recognised board, and two adjacent columns of identically-styled badges is a
 * row that reads as one wide field. See `posting-table-body.tsx`. That is also
 * what leaves `ghost` as the only candidate above rather than one of two.
 *
 * `satisfies` rather than a bare object, so a fifth `PostingStatus` fails to
 * compile here as well as in {@link POSTING_STATUS_LABELS} — as a fourth did,
 * in the deployment that merged `not-interested` and this column together.
 *
 * Ordered as {@link POSTING_STATUS_LABELS} orders it: the sequence a person
 * moves through, not the order the union declares.
 */
const STATUS_VARIANTS = {
  new: "outline",
  applied: "default",
  "not-interested": "ghost",
  rejected: "destructive",
} satisfies Record<PostingStatus, ComponentProps<typeof Badge>["variant"]>

/**
 * Where one application stands, as a cell of the Postings table.
 *
 * **Read-only, and that is the whole distinction from `PostingStatusSelect`.**
 * The status was only ever visible once a row was expanded, which made "which of
 * these have I applied to" a question answered twenty-five times instead of
 * once. This shows the value; the panel still owns changing it, for the reasons
 * that file's docblock gives — a `Select` is a wide control to repeat down a
 * page, and Radix sets `aria-expanded` on its trigger while open, which trips
 * the `has-aria-expanded:bg-muted/50` row highlight that belongs to the
 * disclosure chevron.
 *
 * ⚠️ **No absent case, unlike the Match and Posted cells beside it.** `status`
 * is `NOT NULL` with a default of `new`, and `toStatus()` in
 * `lib/postings/list-postings.ts` degrades a value it does not recognise to
 * `new` rather than to nothing — so there is no em-dash branch to write here,
 * and adding one would be a state the column cannot reach.
 *
 * A server component: nothing here is interactive, and the row it sits in is
 * already inside a client boundary either way. The `import type` on
 * `PostingStatus` is still load-bearing for the same reason
 * `posting-status-labels.ts` gives — `@workspace/db` carries the Prisma client
 * and `pg`, and this file is reachable from `posting-table-body.tsx`, which is
 * `"use client"`.
 */
export function PostingStatusBadge({ status }: { status: PostingStatus }) {
  return (
    <Badge variant={STATUS_VARIANTS[status]}>
      {POSTING_STATUS_LABELS[status]}
    </Badge>
  )
}
