import { pageHref, type PostingQuery } from "@/lib/postings/posting-query"
import type { PostingPage } from "@/lib/postings/list-postings"
import Link from "next/link"

/**
 * Which page of the table is on screen, and how to reach the others.
 *
 * **Hand-rolled, and deliberately not shadcn's `pagination`.** That component
 * is styled anchors: it computes no page numbers, decides nothing about the
 * boundaries, and knows nothing about a query string — so it would supply class
 * names and none of the three decisions this needs, while adding a component to
 * a shared package that exactly one page uses.
 *
 * **Plain `<Link>`s, no client state.** The page is in the URL, so it survives
 * a reload and can be shared, and every navigation re-renders on the server
 * with the right rows.
 *
 * At a boundary the control becomes a `<span>` rather than a disabled link: a
 * link that goes nowhere is still focusable and still announced as a link, and
 * "Previous" on page one has no destination to give it.
 */
export function PostingPagination({
  page: view,
  query,
}: {
  page: PostingPage
  query: PostingQuery
}) {
  const { page, pageCount, pageSize, total, postings } = view

  const first = (page - 1) * pageSize + 1
  const last = first + postings.length - 1

  return (
    <nav
      aria-label="Postings pages"
      className="flex flex-wrap items-center justify-between gap-2"
    >
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Showing {first}–{last} of {total} postings
        {pageCount > 1 ? ` — page ${page} of ${pageCount}` : ""}
      </p>

      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <Step
            href={pageHref(page - 1, query)}
            label="Previous"
            enabled={page > 1}
          />
          <Step
            href={pageHref(page + 1, query)}
            label="Next"
            enabled={page < pageCount}
          />
        </div>
      ) : null}
    </nav>
  )
}

function Step({
  href,
  label,
  enabled,
}: {
  href: string
  label: string
  enabled: boolean
}) {
  if (!enabled) {
    return (
      <span className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground opacity-50">
        {label}
      </span>
    )
  }

  return (
    <Link
      href={href}
      className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
    >
      {label}
    </Link>
  )
}
