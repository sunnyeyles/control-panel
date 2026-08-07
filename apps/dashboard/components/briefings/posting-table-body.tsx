"use client"

import { Suspense, useCallback, useRef, useState } from "react"

import { loadPostingDetailAction } from "@/app/(app)/briefings/actions"
import {
  CoverLetterCell,
  type CoverLetterPromise,
} from "@/components/briefings/cover-letter-cell"
import { DeletePostingsDialog } from "@/components/briefings/delete-postings-dialog"
import {
  PostingDetail,
  type PostingDetailState,
} from "@/components/briefings/posting-detail"
import { usePostingSelection } from "@/components/briefings/posting-selection"
import type { TailoredResumePromise } from "@/components/briefings/use-tailored-resume"
import type { PostingView } from "@/lib/postings/list-postings"
import { POSTING_COLSPAN } from "@/lib/postings/posting-columns"
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
 * ⚠️ **`letters` and `tailoredResumes` are passed straight through and never
 * read here.** Both are promises, and `use()` suspends whatever component calls
 * it — reading either in this component would hold the entire table behind the
 * page's S3 round trips and undo the reason the page stopped awaiting them. Only
 * the leaves read them, each behind its own boundary. See `cover-letter-cell.tsx`
 * and `use-tailored-resume.ts`.
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

  return (
    <TableBody>
      {postings.map((posting) => (
        <PostingRow
          key={posting.id}
          posting={posting}
          letters={letters}
          tailoredResumes={tailoredResumes}
          detail={details[posting.id] ?? PENDING}
          onWarm={() => warm(posting.id)}
          expanded={expandedId === posting.id}
          onToggle={() => {
            // Before the state change rather than in an effect after it: the
            // request and the expansion start in the same tick, so a row whose
            // hover never happened (keyboard, touch) still begins loading the
            // moment it is opened rather than a render later.
            warm(posting.id)
            setExpandedId((current) =>
              current === posting.id ? null : posting.id
            )
          }}
        />
      ))}
    </TableBody>
  )
}

/**
 * The detail for every row that has been opened or pointed at, kept for as long
 * as the page is.
 *
 * ⚠️ **The cache is what makes an on-demand fetch acceptable.** Closing and
 * reopening a row, or opening the same one twice while comparing it against
 * another, must not be a second request — and this state lives in the body,
 * which outlives any one row's expansion.
 *
 * ⚠️ **`asked` is a ref, not state, and that is deliberate.** It guards against
 * a second request for a row already being fetched — hover then click is the
 * ordinary case, and both call {@link warm} — and it must be consulted and
 * updated within one synchronous call. A `useState` set would not be visible to
 * the click that follows the hover in the same tick, and the row would ask
 * twice.
 *
 * A failure removes its entry from `asked`, so pointing at the row again
 * retries. Nothing else does: there is no retry button, because the gesture that
 * opened the panel is the gesture that retries it.
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
 * Not a fourth state, deliberately: the only way a detail is looked at is by
 * expanding the row, and expanding it asks. "Never asked" and "asked, waiting"
 * are the same thing from the panel's side, and a distinct `idle` would be a
 * branch in `posting-detail.tsx` that nothing could ever render.
 */
const PENDING: PostingDetailState = { status: "loading" }

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
 * **The whole row is the target, and the controls inside it handle themselves.**
 * The `<tr>` toggles the detail, so aiming at the company or the date works as
 * well as aiming at the chevron. The row shares that space with three real
 * controls — the selection checkbox, the chevron, and the delete trigger — each
 * of which keeps its own `onClick`, and the row's handler ignores any click that
 * came from inside one. That single guard is what a `stopPropagation` on every
 * control would otherwise have to do, in one place instead of three, and it
 * still holds when a fourth control lands in the row.
 *
 * Local to this file rather than a module of its own. It renders a pair of
 * sibling `<tr>`s and is the only thing that ever will, and splitting it out is
 * what previously put the detail row's `colSpan` in a different file from the
 * headers it had to agree with.
 */
function PostingRow({
  posting,
  letters,
  tailoredResumes,
  detail,
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
   * Start fetching the detail without opening anything.
   *
   * Bound to pointer-enter and focus, so the request for a row someone is about
   * to click is usually finished before they click it. Idempotent — see
   * `usePostingDetails` — so a row hovered five times is fetched once.
   */
  onWarm: () => void
  expanded: boolean
  onToggle: () => void
}) {
  const detailId = `posting-detail-${posting.id}`
  const { isSelected, toggle } = usePostingSelection()
  const selected = isSelected(posting.id)

  return (
    <>
      {/*
        The click target is the whole row, so aiming at the company or the date
        opens the detail exactly as aiming at the chevron does. `TableRow`
        already carries `hover:bg-muted/50`, so only the cursor is missing.
        `data-state` rather than a class of our own: the shared `TableRow`
        already styles `data-[state=selected]:bg-muted`, and `TableCell` already
        tightens the padding of a cell holding a checkbox.

        Two gestures must not toggle, and both are handled here rather than by a
        `stopPropagation` in each control:

        ⚠️ **A click that landed on a control belongs to that control.** The
        checkbox and the delete trigger both render as `<button>`s *inside* this
        `<tr>`, so without this guard ticking a row for deletion, or opening its
        confirmation, would also expand the detail underneath it. `closest`
        rather than a check on `currentTarget`, because the click lands on the
        icon inside the button as often as on the button itself.

        Selecting text is the other: releasing a drag fires a click on the row,
        and having the panel open every time someone highlights a company name
        to copy it makes the table hostile to read. A collapsed selection is a
        click; anything else is a drag.
      */}
      <TableRow
        data-state={selected ? "selected" : undefined}
        className="cursor-pointer"
        /*
          Warming the detail, not opening it. Expanding a row costs one small
          request now — see `lib/postings/load-posting-detail.ts` — and this is
          what usually hides it: by the time a click lands, the reply is in.

          Both events, because they are different people. `onPointerEnter` is
          the mouse; `onFocusCapture` is a keyboard tabbing through the row's
          controls, which never fires a pointer event and would otherwise be the
          only user who watches the skeleton. Capture rather than bubble because
          focus does not bubble.
        */
        onPointerEnter={onWarm}
        onFocusCapture={onWarm}
        onClick={(event) => {
          // `Element` and not `HTMLElement`: a click on the chevron lands on
          // the `<svg>` inside the button, which is an `SVGElement`. `closest`
          // is defined on `Element`, so it covers both.
          if ((event.target as Element).closest("button, input, a, label")) {
            return
          }
          if (window.getSelection()?.isCollapsed === false) return
          onToggle()
        }}
      >
        <TableCell className="w-8">
          <Checkbox
            checked={selected}
            onCheckedChange={() => toggle(posting.id)}
            aria-label={`Select ${posting.title}`}
          />
        </TableCell>

        {/*
          The disclosure control, and the row's accessibility in one place: it
          is the focusable thing, it names what it does, and it is what a screen
          reader is told about. It keeps its own `onClick`: the row's handler
          ignores clicks that came from inside a control, so the chevron — a
          control like the two beside it — has to answer for its own, and that
          is also what makes Enter and Space on the focused button work.

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
          Which board found it, derived from the URL rather than stored — see
          `lib/postings/posting-source.ts`.

          The outline variant is not decoration: it marks a host no board in
          `JOB_BOARDS` claimed, and the label beside it is that hostname. This
          page is where a board missing from the registry becomes visible, so
          the two states have to look different. An em-dash means the stored URL
          would not parse at all, which is a third thing again.
        */}
        <TableCell>
          {posting.source ? (
            <Badge
              variant={posting.source.recognised ? "secondary" : "outline"}
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
        <TableCell className="w-12">
          <DeletePostingsDialog
            postingIds={[posting.id]}
            postingTitle={posting.title}
            letters={letters}
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
}
