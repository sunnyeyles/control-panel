import {
  sortHref,
  type PostingQuery,
  type PostingSort,
} from "@/lib/postings/posting-query"
import { Button } from "@workspace/ui/components/button"
import { TableHead } from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react"
import Link from "next/link"

/**
 * One sortable column heading.
 *
 * ⚠️ **`aria-sort` is not decoration.** A screen reader cannot see the arrow,
 * so without it a sorted table is indistinguishable from an unsorted one. The
 * arrow is `aria-hidden` because it says the same thing a second time.
 *
 * **A `<Link>` in a `Button`, and no client state anywhere.** The sort lives in
 * the URL, so it survives a reload and is shareable, and `<Link>` maintains
 * scroll position by default (`02-components/link.md:232`). `asChild` keeps the
 * anchor real, so middle-click and "open in new tab" still work on a heading.
 *
 * Inactive shows a faded double arrow rather than nothing: a heading that only
 * reveals itself as sortable once clicked is a control nobody finds.
 */
export function PostingSortHeader({
  column,
  label,
  width,
  visibility,
  query,
}: {
  column: PostingSort
  /**
   * A node rather than a string, so the caller can pass
   * `<PostingColumnHeading>` — which renders a column's long and short
   * spellings and hides one in CSS. See `PostingColumn.shortLabel`.
   */
  label: React.ReactNode
  /**
   * This column's width class, from `POSTING_COLUMNS`. Passed in because this
   * component renders its own `<TableHead>`, the only place the class can land;
   * under `table-fixed` a heading that dropped it would size itself from its
   * content and take the column with it.
   */
  width: string
  /**
   * This column's visibility class, or `undefined` for a column rendered at
   * every width. Here for the same reason `width` is — **Posted** is sortable
   * and hides below `md`, so without it the table drops that column's cells and
   * keeps its heading.
   */
  visibility?: string
  /** The view currently rendered, which decides both arrow and destination. */
  query: PostingQuery
}) {
  const active = query.sort === column

  return (
    <TableHead
      className={cn(width, visibility)}
      aria-sort={
        active
          ? query.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      {/*
        `-ml-2.5` cancels the button's own left padding, so a sortable heading
        sits on the same line as a plain one. Without it the two kinds of
        heading are visibly misaligned in the same row.
      */}
      <Button variant="ghost" size="sm" asChild className="-ml-2.5">
        <Link href={sortHref(column, query)}>
          {label}
          {active ? (
            query.direction === "asc" ? (
              <ArrowUpIcon aria-hidden="true" />
            ) : (
              <ArrowDownIcon aria-hidden="true" />
            )
          ) : (
            <ChevronsUpDownIcon aria-hidden="true" className="opacity-50" />
          )}
        </Link>
      </Button>
    </TableHead>
  )
}
