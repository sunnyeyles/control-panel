import { pageHref, type PostingQuery } from "@/lib/postings/posting-query"
import type { PostingPage } from "@/lib/postings/list-postings"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import Link from "next/link"

/**
 * Which page of the table is on screen, and how to reach the others.
 *
 * **Deliberately not shadcn's `pagination`**: it is styled anchors, computing
 * no page numbers and knowing nothing about a query string, so it would supply
 * class names and none of the three decisions this needs. Those class names
 * come from `buttonVariants` instead.
 *
 * **Plain `<Link>`s, no client state.** The page is in the URL, so it survives
 * a reload and every navigation re-renders on the server with the right rows.
 */
export function PostingPagination({
  page: view,
  query,
}: {
  page: PostingPage
  query: PostingQuery
}) {
  const { page, pageCount, pageSize, total, hidden, postings } = view

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
        {/*
          ⚠️ Not decoration. A filter that quietly shrinks the table looks
          exactly like briefings that stopped finding anything, so this line is
          what stands between a working filter and a bug report. Same
          `aria-live` region as the count, since "40 postings" alone is the
          misleading half — and the link puts the cause one click away.
        */}
        {hidden > 0 ? (
          <>
            {" — "}
            <Link href="/jobs/schedules" className="underline">
              {hidden === 1
                ? "1 hidden by your title filters"
                : `${hidden} hidden by your title filters`}
            </Link>
          </>
        ) : null}
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

/**
 * One end of the pager.
 *
 * At a boundary this is a `<span>` wearing the button's classes rather than a
 * disabled link or a disabled `<button>`: a link that goes nowhere is still
 * focusable and still announced as a link, and "Previous" on page one has no
 * destination to give it. `buttonVariants` is used directly for exactly that
 * reason — the element must not be a `Button`, only look like one.
 */
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
      <span
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "text-muted-foreground opacity-50"
        )}
      >
        {label}
      </span>
    )
  }

  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href}>{label}</Link>
    </Button>
  )
}
