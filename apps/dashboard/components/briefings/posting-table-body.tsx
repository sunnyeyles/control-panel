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
      <TableRow>
        {/*
          The disclosure control. A chevron and not the title, because an
          underlined title means "this navigates" and it does not — it expands
          the row underneath.

          ⚠️ `aria-expanded` has to stay on a control *inside* the row: the
          shared `TableRow` highlights an open row with
          `has-aria-expanded:bg-muted/50`, which is a `:has()` selector looking
          for exactly this attribute.
        */}
        <TableCell className="w-8">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={onToggle}
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
          The title toggles the same detail, because a row's name is what people
          aim at. `h-auto`, `py-0` and `whitespace-normal` undo the button
          defaults: a long advertisement title has to wrap inside the cell
          rather than stretch the column to fit on one line.
        */}
        <TableCell className="max-w-xs font-medium">
          <Button
            type="button"
            variant="link"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={onToggle}
            className="h-auto px-0 py-0 text-left font-medium whitespace-normal text-foreground"
          >
            {posting.title}
          </Button>
        </TableCell>

        <TableCell>{posting.company}</TableCell>

        <TableCell className="text-muted-foreground">
          {posting.location}
        </TableCell>

        {/*
          Whatever the advertisement said, verbatim — free text inside
          `postings.payload`, not a date the app parsed, so there is nothing to
          format and nothing to order by. The scout is instructed to omit rather
          than estimate, so an em-dash means the advertisement did not say, not
          that anything failed.
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
