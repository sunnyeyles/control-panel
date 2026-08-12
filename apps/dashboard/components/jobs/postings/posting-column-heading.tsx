import type { PostingColumn } from "@/lib/postings/posting-columns"

/**
 * One column's heading text, at whichever length fits.
 *
 * ⚠️ **A `<th>` narrower than its own words spills sideways.** `TableHead` is
 * `whitespace-nowrap`, so it neither wraps nor truncates — "Cover letter" ran
 * straight across the delete control in the 67px that column gets below `md`.
 * `shortLabel` is the fix, applied only here.
 *
 * ⚠️ **Both spellings render and one is hidden in CSS**, rather than picking in
 * JavaScript: that means reading a media query, which differs between server and
 * browser, and the header row is a server component.
 *
 * A component rather than a helper in `posting-columns.ts` (which imports no
 * React by design), and shared because `posting-table-skeleton.tsx` renders the
 * real headings too — a swap in only one gives the fallback a different width.
 */
export function PostingColumnHeading({ column }: { column: PostingColumn }) {
  if (column.shortLabel === undefined) return column.label

  return (
    <>
      <span className="md:hidden">{column.shortLabel}</span>
      <span className="hidden md:inline">{column.label}</span>
    </>
  )
}
