import type { ComponentProps } from "react"

import { POSTING_STATUS_LABELS } from "@/lib/postings/posting-status-labels"
import type { PostingStatus } from "@workspace/db"
import { Badge } from "@workspace/ui/components/badge"

/**
 * How each status is drawn, so twenty-five of them read as a column rather than
 * as twenty-five announcements.
 *
 * `new` is `outline` because it is the majority: a filled badge on every row
 * would out-shout the Match column the table is scanned for. `not-interested` is
 * quieter still — `ghost` lets a passed-on advertisement recede while still
 * naming its state.
 *
 * ⚠️ `secondary` is deliberately unused, though it would suit `new`: the Source
 * column two cells left already uses it, and two adjacent columns of identical
 * badges read as one wide field.
 *
 * `satisfies` so a fifth `PostingStatus` fails to compile here as well as in
 * {@link POSTING_STATUS_LABELS}, whose order this follows.
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
 * Read-only, which is the whole distinction from `PostingStatusSelect`; that
 * file's docblock says why the control stays in the detail panel.
 *
 * No absent case, unlike the Match and Posted cells beside it: `status` is
 * `NOT NULL` defaulting to `new`, and `toStatus()` degrades an unrecognised
 * value to `new`, so an em-dash branch would be unreachable.
 *
 * ⚠️ The `import type` on `PostingStatus` is load-bearing: `@workspace/db`
 * carries the Prisma client and `pg`, and this file is reachable from
 * `posting-table-body.tsx`, which is `"use client"`.
 */
export function PostingStatusBadge({ status }: { status: PostingStatus }) {
  return (
    <Badge variant={STATUS_VARIANTS[status]}>
      {POSTING_STATUS_LABELS[status]}
    </Badge>
  )
}
