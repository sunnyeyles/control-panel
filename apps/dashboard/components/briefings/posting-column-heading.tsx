import type { PostingColumn } from "@/lib/postings/posting-columns"

/**
 * One column's heading text, at whichever length fits.
 *
 * ⚠️ **A `<th>` narrower than its own words spills sideways.** `TableHead` is
 * `whitespace-nowrap`, so it neither wraps nor truncates — "Cover letter" in the
 * 67px that column resolves to below `md` ran straight across the delete control
 * beside it. `shortLabel` is the fix, and this is the one place it is applied.
 *
 * ⚠️ **Both spellings are rendered and one is hidden, rather than one being
 * chosen.** Picking in JavaScript means reading a media query, which renders
 * differently on the server than in the browser — and the header row is a server
 * component. The cost is one hidden `<span>` per heading.
 *
 * A component rather than a helper in `posting-columns.ts`, which imports no
 * React by design — and shared rather than inlined, because
 * `posting-table-skeleton.tsx` renders the real headings too, so a swap done in
 * only one of them is a fallback whose header is a different width from the
 * table replacing it.
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
