import {
  sortHref,
  type PostingQuery,
  type PostingSort,
} from "@/lib/postings/posting-query"
import { Button } from "@workspace/ui/components/button"
import { TableHead } from "@workspace/ui/components/table"
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react"
import Link from "next/link"

/**
 * One sortable column heading.
 *
 * ⚠️ **`aria-sort` is not decoration.** Visually a sorted column is announced
 * by an arrow, and a screen reader cannot see one — without this attribute a
 * sorted table is indistinguishable from an unsorted one, and the user is told
 * neither which column the rows are in nor which way. The arrow beside it is
 * `aria-hidden`, because it says the same thing a second time and would read
 * out as a stray character.
 *
 * **A `<Link>` in a `Button`, and no client state anywhere.** The sort lives in
 * the URL, so it survives a reload and can be shared, and the page re-renders on
 * the server with the new order. Next's own docs note that `<Link>` maintains
 * scroll position by default (`02-components/link.md:232`), so clicking a
 * header does not throw the reader back to the top of a table they had scrolled
 * into. `asChild` is what keeps that a real anchor: the button supplies the
 * styling and the anchor stays the element, so middle-click and "open in new
 * tab" still work on a heading.
 *
 * The inactive state shows a faded double arrow rather than nothing, because a
 * heading that only reveals itself as sortable once it has been clicked is a
 * control nobody finds.
 */
export function PostingSortHeader({
  column,
  label,
  width,
  query,
}: {
  column: PostingSort
  label: string
  /**
   * This column's width class, from `POSTING_COLUMNS`.
   *
   * Passed in rather than looked up, because this component renders its own
   * `<TableHead>` — so it is the only place the class can land, and the table is
   * `table-fixed`. A sortable heading that dropped it would size itself from
   * its content and take the column with it.
   */
  width: string
  /** The view currently rendered, which decides both arrow and destination. */
  query: PostingQuery
}) {
  const active = query.sort === column

  return (
    <TableHead
      className={width}
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
