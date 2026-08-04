import {
  sortHref,
  type PostingQuery,
  type PostingSort,
} from "@/lib/postings/posting-query"
import { TableHead } from "@workspace/ui/components/table"
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
 * **A plain `<Link>`, and no client state anywhere.** The sort lives in the
 * URL, so it survives a reload and can be shared, and the page re-renders on
 * the server with the new order. Next's own docs note that `<Link>` maintains
 * scroll position by default (`02-components/link.md:232`), so clicking a
 * header does not throw the reader back to the top of a table they had scrolled
 * into.
 */
export function PostingSortHeader({
  column,
  label,
  query,
  className,
}: {
  column: PostingSort
  label: string
  /** The view currently rendered, which decides both arrow and destination. */
  query: PostingQuery
  className?: string
}) {
  const active = query.sort === column

  return (
    <TableHead
      aria-sort={
        active
          ? query.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      className={className}
    >
      <Link
        href={sortHref(column, query)}
        className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
      >
        {label}
        {active ? (
          <span aria-hidden="true">
            {query.direction === "asc" ? "↑" : "↓"}
          </span>
        ) : null}
      </Link>
    </TableHead>
  )
}
