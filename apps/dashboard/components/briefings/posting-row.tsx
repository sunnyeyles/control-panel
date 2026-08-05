"use client"

import { PostingDetail } from "@/components/briefings/posting-detail"
import type { CoverLetterRow } from "@/lib/cover-letters/cover-letter-rows"
import { PostingStatusSelect } from "@/components/briefings/posting-status-select"
import type { PostingView } from "@/lib/postings/list-postings"
import { TableCell, TableRow } from "@workspace/ui/components/table"

/** Matches the header columns in `posting-table.tsx`. */
const COLUMN_COUNT = 7

/**
 * One advertisement as a compact row, plus its expanded detail when open.
 *
 * Takes only strings — every `Date` was formatted in
 * `lib/postings/list-postings.ts`. See `components/documents/document-list.tsx`
 * for why that boundary matters: a `Date` formatted in the browser uses the
 * browser's locale and timezone, and React reports the disagreement as a
 * hydration mismatch rather than as the timezone bug it is.
 *
 * **Expansion state is owned above this component**, not in the URL. Closing
 * must return to the same page of the same sort at the same scroll position,
 * and a `?posting=` parameter would make every open and close a navigation —
 * the one thing the sort headers and the pagination links are careful to keep
 * cheap. Opening a different posting collapses this one because the parent
 * keeps a single expanded id.
 *
 * The compact row carries only what is worth scanning. Summary, highlights,
 * match reason, and all three Cover Letter controls live in the detail row
 * the title discloses. The whole `PostingView` goes down as props — the page
 * already holds every field, so opening the detail costs no query.
 */
export function PostingRow({
  posting,
  letter,
  expanded,
  onToggle,
}: {
  posting: PostingView
  /** The letter already drafted for this Posting, if there is one. */
  letter?: CoverLetterRow
  expanded: boolean
  onToggle: () => void
}) {
  const detailId = `posting-detail-${posting.id}`

  return (
    <>
      <TableRow>
        <TableCell className="max-w-xs font-medium">
          {/*
            The title is a disclosure control: it expands this posting's detail
            under the row rather than navigating away or opening a dialog. The
            advertisement itself is one click further in, inside the detail.
          */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={onToggle}
            className="rounded-sm text-left font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {posting.title}
            <span className="sr-only">
              {expanded
                ? " — hide this posting's detail"
                : " — show this posting's detail"}
            </span>
          </button>

          {posting.postedAt ? (
            <span className="block text-xs text-muted-foreground">
              Posted {posting.postedAt}
            </span>
          ) : null}
        </TableCell>

        <TableCell>{posting.company}</TableCell>

        <TableCell className="text-muted-foreground">
          {posting.location}
        </TableCell>

        <TableCell>
          {/*
            The one column on this row a person writes. Everything else is
            whatever the last Run that saw the advertisement reported, which is
            why `recordPostings` in `@workspace/db` leaves `status` alone on
            conflict — a re-find must not undo an "applied".

            The title is passed for the control's accessible label, so twenty-five
            of these down the column are distinguishable to a screen reader.

            It stays on the compact row rather than moving into the detail: it
            is the one interaction worth having without opening anything, and
            the column it sits under is sortable.
          */}
          <PostingStatusSelect
            postingId={posting.id}
            status={posting.status}
            title={posting.title}
          />
        </TableCell>

        <TableCell className="whitespace-nowrap text-muted-foreground">
          {posting.firstSeen}
        </TableCell>

        <TableCell className="whitespace-nowrap text-muted-foreground">
          {posting.lastSeen}
        </TableCell>

        <TableCell className="whitespace-nowrap text-muted-foreground">
          {/*
            Whether there is a letter, not what can be done with it — drafting,
            editing and downloading live in the expanded detail. The column is
            worth keeping because "have I written to this one yet" is a scanning
            question, and answering it per row is what stops the user opening
            twenty-five details to find out.
          */}
          {letter ? (
            "Drafted"
          ) : (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">No cover letter</span>
            </>
          )}
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell
            id={detailId}
            colSpan={COLUMN_COUNT}
            className="whitespace-normal"
          >
            <PostingDetail posting={posting} letter={letter} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
