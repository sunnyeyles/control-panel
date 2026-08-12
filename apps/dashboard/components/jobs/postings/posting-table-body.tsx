"use client"

import { memo, Suspense, useCallback, useRef, useState } from "react"

import { loadPostingDetailAction } from "@/app/(app)/jobs/actions"
import {
  CoverLetterCell,
  type CoverLetterPromise,
} from "@/components/jobs/postings/cover-letter-cell"
import { DeletePostingsDialog } from "@/components/jobs/postings/delete-postings-dialog"
import {
  PostingDetail,
  type PostingDetailState,
} from "@/components/jobs/postings/posting-detail"
import { usePostingSelection } from "@/components/jobs/postings/posting-selection"
import { PostingStatusBadge } from "@/components/jobs/postings/posting-status-badge"
import type { TailoredResumePromise } from "@/components/jobs/postings/use-tailored-resume"
import type { PostingView } from "@/lib/postings/list-postings"
import {
  POSTING_ACTIONS_WIDTH,
  POSTING_COLSPAN,
  POSTING_EXPAND_WIDTH,
  POSTING_HIDE_BELOW_LG,
  POSTING_HIDE_BELOW_MD,
  POSTING_ROW_HEIGHT,
  POSTING_SELECT_WIDTH,
} from "@/lib/postings/posting-columns"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { TableBody, TableCell, TableRow } from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"
import { ChevronRightIcon, Trash2Icon } from "lucide-react"

/**
 * The table's body, and the client boundary that owns which posting is open.
 *
 * Expansion is local state, one id at a time, never the URL: a `?posting=`
 * parameter would make every open and close a navigation, losing the page,
 * sort and scroll position the sort headers work to keep cheap.
 *
 * ⚠️ `letters` and `tailoredResumes` are passed straight through and never read
 * here. `use()` suspends its caller, so reading either would hold the whole
 * table behind the page's S3 round trips; only the leaves read them.
 *
 * ⚠️ This component is the table's single subscriber and {@link PostingRow} is
 * memoized behind it, so every prop below must stay referentially stable across
 * a tick/expand/fetch re-render. That is why {@link usePostingSelection} is read
 * here rather than in the row, and why the handlers take a posting id rather
 * than closing over one.
 */
export function PostingTableBody({
  postings,
  letters,
  tailoredResumes,
}: {
  postings: readonly PostingView[]
  letters: CoverLetterPromise
  tailoredResumes: TailoredResumePromise
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { details, warm } = usePostingDetails()
  // `isSelected` answers from the visible-page intersection, which is the whole
  // safety property of `posting-selection.tsx` — reading the raw set here to
  // save a render would put a second membership rule in a second file.
  const { isSelected, toggle } = usePostingSelection()

  // Stable, so it is the same prop on every row across an unrelated re-render.
  // `warm` is already stable — see `usePostingDetails` — and the functional
  // updater is what lets this close over nothing else.
  const toggleExpanded = useCallback(
    (postingId: string) => {
      // Before the state change rather than in an effect after it: the request
      // and the expansion start in the same tick, so a row whose hover never
      // happened (keyboard, touch) still begins loading the moment it is opened
      // rather than a render later.
      warm(postingId)
      setExpandedId((current) => (current === postingId ? null : postingId))
    },
    [warm]
  )

  return (
    <TableBody>
      {postings.map((posting) => (
        <PostingRow
          key={posting.id}
          posting={posting}
          letters={letters}
          tailoredResumes={tailoredResumes}
          detail={details[posting.id] ?? PENDING}
          selected={isSelected(posting.id)}
          onToggleSelect={toggle}
          onWarm={warm}
          expanded={expandedId === posting.id}
          onToggle={toggleExpanded}
        />
      ))}
    </TableBody>
  )
}

/**
 * The detail for every row that has been opened or pointed at, kept for as long
 * as the page is.
 *
 * The cache is what makes an on-demand fetch acceptable: reopening a row must
 * not be a second request, and this state outlives any one row's expansion.
 *
 * ⚠️ `asked` is a ref, not state: hover then click both call {@link warm} in one
 * tick, and a `useState` set would not be visible to the click, so the row would
 * ask twice. A failure removes its entry, so the reopening gesture retries.
 */
function usePostingDetails() {
  const [details, setDetails] = useState<Record<string, PostingDetailState>>({})
  const asked = useRef<Set<string>>(new Set())

  const warm = useCallback((postingId: string) => {
    if (asked.current.has(postingId)) return
    asked.current.add(postingId)

    setDetails((current) => ({
      ...current,
      [postingId]: { status: "loading" },
    }))

    loadPostingDetailAction(postingId)
      .then((result) => {
        if (result.status === "success") {
          setDetails((current) => ({
            ...current,
            [postingId]: { status: "ready", view: result.detail },
          }))
          return
        }

        asked.current.delete(postingId)
        setDetails((current) => ({
          ...current,
          [postingId]: { status: "failed", message: result.message },
        }))
      })
      .catch((error: unknown) => {
        // A Server Action that rejects rather than returning its union — the
        // network went away, or the deployment did. The action's own failures
        // all come back through the branch above.
        console.error("postings: could not load the detail", error)
        asked.current.delete(postingId)
        setDetails((current) => ({
          ...current,
          [postingId]: {
            status: "failed",
            message: "Those details could not be loaded.",
          },
        }))
      })
  }, [])

  return { details, warm }
}

/**
 * A row nobody has asked about yet reads as `loading`.
 *
 * Not a fourth state: expanding a row is what asks, so "never asked" and
 * "waiting" are the same thing from the panel's side and an `idle` branch in
 * `posting-detail.tsx` could never render.
 */
const PENDING: PostingDetailState = { status: "loading" }

/**
 * One advertisement as a compact row, plus its expanded detail when open.
 *
 * Takes only strings — every `Date` was formatted in
 * `lib/postings/list-postings.ts`. Formatting a `Date` in the browser uses the
 * browser's locale and timezone, which React reports as a hydration mismatch
 * rather than as the timezone bug it is.
 *
 * Status shows on the row but its control does not: the value is a scanning aid,
 * the `Select` is a wide control nobody wants twenty-five of.
 *
 * The whole `<tr>` toggles the detail, and its handler ignores clicks that came
 * from inside the checkbox, chevron or delete trigger — one guard instead of a
 * `stopPropagation` in each, and it still holds for a fourth control.
 *
 * Local to this file because it renders a pair of sibling `<tr>`s and splitting
 * it out put the detail row's `colSpan` away from the headers it must match.
 *
 * ⚠️ Memoized, and only worth it while every prop stays cheap to compare — see
 * {@link PostingTableBody}. A prop built inline at the call site (object
 * literal, array, closure over `posting`) silently undoes it.
 */
const PostingRow = memo(function PostingRow({
  posting,
  letters,
  tailoredResumes,
  detail,
  selected,
  onToggleSelect,
  onWarm,
  expanded,
  onToggle,
}: {
  posting: PostingView
  letters: CoverLetterPromise
  tailoredResumes: TailoredResumePromise
  /** This row's fetched detail, or where that fetch has got to. */
  detail: PostingDetailState
  /**
   * Whether this row is ticked, resolved by the parent against the visible page.
   * A boolean rather than this row reading the context, so a tick elsewhere does
   * not re-render it.
   */
  selected: boolean
  /** Tick or untick this row. Stable, and takes the id for that reason. */
  onToggleSelect: (postingId: string) => void
  /**
   * Start fetching the detail without opening anything. Bound to pointer-enter
   * and focus, and idempotent — a row hovered five times is fetched once.
   */
  onWarm: (postingId: string) => void
  expanded: boolean
  onToggle: (postingId: string) => void
}) {
  const detailId = `posting-detail-${posting.id}`

  // Bound here rather than passed down already bound: these are DOM handlers,
  // so they cannot take an id, and a closure minted inside a memoized row costs
  // nothing — the row is what stopped re-rendering.
  const warmThis = () => onWarm(posting.id)
  const toggleThis = () => onToggle(posting.id)

  return (
    <>
      {/*
        The click target is the whole row. `data-state` rather than a class of
        our own — the shared `TableRow` already styles
        `data-[state=selected]:bg-muted`.

        Two gestures must not toggle, both handled here rather than by a
        `stopPropagation` in each control:

        ⚠️ A click that landed on the checkbox or the delete trigger belongs to
        it — `closest`, not `currentTarget`, since the click often lands on the
        icon inside the button.

        ⚠️ Releasing a text-selection drag also fires a click on the row. A
        collapsed selection is a click; anything else is a drag.
      */}
      <TableRow
        data-state={selected ? "selected" : undefined}
        /*
          ⚠️ **A declared height, and `posting-table-skeleton.tsx` declares the
          same one.** The title wraps to a second line when an advertisement has
          a long one, so without this a page is a mix of one- and two-line rows
          and no fallback can reserve the right space for twenty-five of them.
          See `POSTING_ROW_HEIGHT`.
        */
        className={cn("cursor-pointer", POSTING_ROW_HEIGHT)}
        /*
          Warming the detail, not opening it, so the reply is usually in by the
          time a click lands. Both events because they are different users: a
          keyboard tab fires no pointer event. Capture, since focus does not
          bubble.
        */
        onPointerEnter={warmThis}
        onFocusCapture={warmThis}
        onClick={(event) => {
          // `Element` and not `HTMLElement`: a click on the chevron lands on
          // the `<svg>` inside the button, which is an `SVGElement`. `closest`
          // is defined on `Element`, so it covers both.
          if ((event.target as Element).closest("button, input, a, label")) {
            return
          }
          if (window.getSelection()?.isCollapsed === false) return
          toggleThis()
        }}
      >
        <TableCell className={POSTING_SELECT_WIDTH}>
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(posting.id)}
            aria-label={`Select ${posting.title}`}
          />
        </TableCell>

        {/*
          The disclosure control, and the row's accessibility in one place. It
          keeps its own `onClick` because the row's handler ignores clicks from
          inside a control, and that is also what makes Enter and Space work.

          ⚠️ `aria-expanded` has to stay on a control *inside* the row: the
          shared `TableRow` highlights an open row with
          `has-aria-expanded:bg-muted/50`, which is a `:has()` selector looking
          for exactly this attribute. Moving it onto the `<tr>` — which now
          looks like the natural home for it — silently drops that highlight,
          because `:has()` matches descendants.
        */}
        <TableCell className={POSTING_EXPAND_WIDTH}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={toggleThis}
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
          Plain text, not a link button: an underline would promise navigation
          that never happens. `whitespace-normal` is still needed — `TableCell`
          defaults to `nowrap`, so a long title would spill out of its column.
        */}
        <TableCell className="font-medium whitespace-normal">
          {/*
            ⚠️ The clamp is on a child, not the cell: `line-clamp-2` sets
            `display: -webkit-box`, which on a `<td>` leaves the table's layout.
            `title` rescues a clipped line on desktop only, which is why
            `posting-detail.tsx` repeats the title in full below `md`.
          */}
          <span className="line-clamp-2" title={posting.title}>
            {posting.title}
          </span>

          {/*
            ⚠️ The company, only below `md` where its own column is not
            rendered. Not `aria-hidden`: the cell below is `display: none` under
            `md`, so this span is the only copy a screen reader has there.
            Exactly one of the two exists at every width.
          */}
          <span className="line-clamp-1 text-xs text-muted-foreground md:hidden">
            {posting.company}
          </span>
        </TableCell>

        {/*
          `truncate` on the four single-line text columns, which the fixed layout
          makes necessary: a cell wider than its column used to widen the column,
          and now overflows it. See `POSTING_COLUMNS`.
        */}
        <TableCell
          className={cn("truncate", POSTING_HIDE_BELOW_MD)}
          title={posting.company}
        >
          {posting.company}
        </TableCell>

        {/*
          ⚠️ The three cells below stop being rendered on a narrow viewport;
          `posting-detail.tsx`'s "Where and when" section is where they go. Same
          constants as the header row and the skeleton.
        */}
        <TableCell
          className={cn(
            "truncate text-muted-foreground",
            POSTING_HIDE_BELOW_MD
          )}
          title={posting.location}
        >
          {posting.location}
        </TableCell>

        {/*
          ⚠️ **Rendered at every width, unlike the three around it.** It is the
          one cell that answers "is this worth my time", which is the question a
          page of twenty-five advertisements is scanned for — so it keeps its
          column on a phone, where Location, Posted and Source give theirs up.

          An em-dash means nobody has scored it yet, which is every Posting until
          the loop in `score-pending-matches.tsx` reaches it. Deliberately not a
          zero and not a spinner: an unscored advertisement is not a badly-matched
          one, and the order puts it last either way — see the `match` branch of
          `orderByFor` in `@workspace/db`.

          `tabular-nums` so a column of two- and three-digit scores lines up
          rather than jittering by digit width.
        */}
        <TableCell className="truncate tabular-nums">
          {posting.matchScore === undefined ? (
            <span className="text-muted-foreground">
              <span aria-hidden="true">—</span>
              <span className="sr-only">Not scored yet</span>
            </span>
          ) : (
            <>
              <span aria-hidden="true">{posting.matchScore}</span>
              <span className="sr-only">
                Matches your resume {posting.matchScore} out of 100
              </span>
            </>
          )}
        </TableCell>

        {/*
          The parsed `postings.posted_at` formatted, or the advertisement's own
          words when the write path could not read a date out of them — one
          string either way, resolved in `lib/postings/list-postings.ts`. The
          scout is instructed to omit rather than estimate, so an em-dash means
          the advertisement did not say, not that anything failed.
        */}
        <TableCell
          className={cn(
            "truncate text-muted-foreground",
            POSTING_HIDE_BELOW_MD
          )}
        >
          {posting.postedAt ?? (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">Posting date not stated</span>
            </>
          )}
        </TableCell>

        {/*
          Which board found it, derived from the URL rather than stored — see
          `lib/postings/posting-source.ts`.

          The outline variant is not decoration: it marks a host no board in
          `JOB_BOARDS` claimed, which is how a missing registry entry becomes
          visible. An em-dash is a third state — the URL would not parse.
        */}
        <TableCell className={cn("truncate", POSTING_HIDE_BELOW_LG)}>
          {posting.source ? (
            <Badge
              variant={posting.source.recognised ? "secondary" : "outline"}
              title={posting.source.label}
            >
              {posting.source.label}
            </Badge>
          ) : (
            <span className="text-muted-foreground">
              <span aria-hidden="true">—</span>
              <span className="sr-only">Source not recognised</span>
            </span>
          )}
        </TableCell>

        {/*
          The value, not the control — `PostingStatusSelect` stays in the detail
          panel. No `truncate` or `title`: a badge, not text, and the column is
          sized against the longest of the three labels.
        */}
        <TableCell className={POSTING_HIDE_BELOW_MD}>
          <PostingStatusBadge status={posting.status} />
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

        {/*
          A list of one, through the same dialog and the same action the bulk
          bar uses. There is no second delete path to keep honest.

          ⚠️ Radix's `DialogTrigger` sets `aria-expanded` while the dialog is
          open, and the shared `TableRow` carries `has-aria-expanded:bg-muted/50`
          — so an open confirmation highlights its row. Harmless, matches what
          the documents table already does, and not to be "fixed" by stripping
          the attribute: the disclosure chevron above depends on that selector.
        */}
        <TableCell className={POSTING_ACTIONS_WIDTH}>
          <DeletePostingsDialog
            postingIds={[posting.id]}
            postingTitle={posting.title}
            letters={letters}
            tailoredResumes={tailoredResumes}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${posting.title}`}
              >
                <Trash2Icon />
              </Button>
            }
          />
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell
            id={detailId}
            colSpan={POSTING_COLSPAN}
            className="max-w-0 break-words whitespace-normal"
          >
            <PostingDetail
              posting={posting}
              detail={detail}
              letters={letters}
              tailoredResumes={tailoredResumes}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
})
