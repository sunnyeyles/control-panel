"use client"

import { Suspense, useState } from "react"

import {
  CoverLetterCell,
  type CoverLetterPromise,
} from "@/components/briefings/cover-letter-cell"
import { PostingDetail } from "@/components/briefings/posting-detail"
import type { PostingView } from "@/lib/postings/list-postings"
import { POSTING_COLSPAN } from "@/lib/postings/posting-columns"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { TableBody, TableCell, TableRow } from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"
import { ChevronRightIcon } from "lucide-react"

/**
 * The table's body, and the client boundary that owns which posting is open.
 *
 * Headers, sorting and pagination stay on the server — they are `<Link>`s that
 * must not remount with every disclosure. Expansion is local state: one id at
 * a time, never the URL, so opening and closing a detail does not fight the
 * query string the rest of the table uses for sort and page.
 *
 * **Expansion state is here rather than in the URL** because closing must return
 * to the same page of the same sort at the same scroll position, and a
 * `?posting=` parameter would make every open and close a navigation — the one
 * thing the sort headers and the pagination links are careful to keep cheap.
 * Opening a different posting collapses the previous one, because there is a
 * single expanded id.
 *
 * ⚠️ **`letters` is passed straight through and never read here.** It is a
 * promise, and `use()` suspends whatever component calls it — reading it in this
 * component would hold the entire table behind the page's S3 round trips and
 * undo the reason the page stopped awaiting them. Only the leaves read it, each
 * behind its own boundary. See `cover-letter-cell.tsx`.
 */
export function PostingTableBody({
  postings,
  letters,
}: {
  postings: readonly PostingView[]
  letters: CoverLetterPromise
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <TableBody>
      {postings.map((posting) => (
        <PostingRow
          key={posting.id}
          posting={posting}
          letters={letters}
          expanded={expandedId === posting.id}
          onToggle={() =>
            setExpandedId((current) =>
              current === posting.id ? null : posting.id
            )
          }
        />
      ))}
    </TableBody>
  )
}

/**
 * One advertisement as a compact row, plus its expanded detail when open.
 *
 * Takes only strings — every `Date` was formatted in
 * `lib/postings/list-postings.ts`. See `components/documents/document-list.tsx`
 * for why that boundary matters: a `Date` formatted in the browser uses the
 * browser's locale and timezone, and React reports the disagreement as a
 * hydration mismatch rather than as the timezone bug it is.
 *
 * The compact row carries only what is worth scanning. Status, both sighting
 * times, the summary, the highlights, the match reason and all three cover
 * letter controls live in the detail row the chevron discloses. The whole
 * `PostingView` goes down as props — the page already holds every field, so
 * opening the detail costs no query.
 *
 * **The whole row is the target, and there is exactly one handler.** It sits on
 * the `<tr>`; the chevron is a real `<button>` that carries the accessibility of
 * the control and no `onClick` of its own, so a pointer click and an Enter or
 * Space on the focused button both arrive at the same place by bubbling. Two
 * handlers with a `stopPropagation` between them would be the same behaviour
 * with a double-toggle waiting behind any future change to either.
 *
 * Local to this file rather than a module of its own. It renders a pair of
 * sibling `<tr>`s and is the only thing that ever will, and splitting it out is
 * what previously put the detail row's `colSpan` in a different file from the
 * headers it had to agree with.
 */
function PostingRow({
  posting,
  letters,
  expanded,
  onToggle,
}: {
  posting: PostingView
  letters: CoverLetterPromise
  expanded: boolean
  onToggle: () => void
}) {
  const detailId = `posting-detail-${posting.id}`

  return (
    <>
      {/*
        The click target is the whole row, so aiming at the company or the date
        opens the detail exactly as aiming at the chevron does. `TableRow`
        already carries `hover:bg-muted/50`, so only the cursor is missing.

        Selecting text is the one gesture that must not toggle: releasing a
        drag fires a click on the row, and having the panel open every time
        someone highlights a company name to copy it makes the table hostile to
        read. A collapsed selection is a click; anything else is a drag.
      */}
      <TableRow
        className="cursor-pointer"
        onClick={() => {
          if (window.getSelection()?.isCollapsed === false) return
          onToggle()
        }}
      >
        {/*
          The disclosure control, and the row's accessibility in one place: it
          is the focusable thing, it names what it does, and it is what a screen
          reader is told about. It carries no `onClick` — the click it produces,
          whether from a pointer or from Enter or Space, bubbles to the handler
          on the row above.

          ⚠️ `aria-expanded` has to stay on a control *inside* the row: the
          shared `TableRow` highlights an open row with
          `has-aria-expanded:bg-muted/50`, which is a `:has()` selector looking
          for exactly this attribute. Moving it onto the `<tr>` — which now
          looks like the natural home for it — silently drops that highlight,
          because `:has()` matches descendants.
        */}
        <TableCell className="w-8">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("transition-transform", expanded && "rotate-90")}
            />
            <span className="sr-only">
              {expanded
                ? `Hide the detail for ${posting.title}`
                : `Show the detail for ${posting.title}`}
            </span>
          </Button>
        </TableCell>

        {/*
          Plain text. It was a `variant="link"` button, which underlined on
          hover — and an underline means "this navigates", which it never did:
          it expanded the row underneath, exactly as every other cell now does.
          `whitespace-normal` is what the removed button was supplying, and it
          is still needed: `TableCell` defaults to `whitespace-nowrap`, so a
          long advertisement title would otherwise stretch the column rather
          than wrap inside it.
        */}
        <TableCell className="max-w-xs font-medium whitespace-normal">
          {posting.title}
        </TableCell>

        <TableCell>{posting.company}</TableCell>

        <TableCell className="text-muted-foreground">
          {posting.location}
        </TableCell>

        {/*
          The parsed `postings.posted_at` formatted, or the advertisement's own
          words when the write path could not read a date out of them — one
          string either way, resolved in `lib/postings/list-postings.ts`. The
          scout is instructed to omit rather than estimate, so an em-dash means
          the advertisement did not say, not that anything failed.
        */}
        <TableCell className="text-muted-foreground">
          {posting.postedAt ?? (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">Posting date not stated</span>
            </>
          )}
        </TableCell>

        {/*
          Its own Suspense boundary, one per row, and that placement is the
          whole performance fix: every other cell paints while the page's
          cover-letter reads are still in flight. All rows share one promise, so
          they resolve together — one wave of skeletons, not twenty-five
          staggered ones.
        */}
        <TableCell className="text-muted-foreground">
          <Suspense fallback={<Skeleton className="size-4" />}>
            <CoverLetterCell postingId={posting.id} letters={letters} />
          </Suspense>
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell
            id={detailId}
            colSpan={POSTING_COLSPAN}
            className="whitespace-normal"
          >
            <PostingDetail posting={posting} letters={letters} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
