import { PostingDetailDialog } from "@/components/briefings/posting-detail-dialog"
import { PostingStatusSelect } from "@/components/briefings/posting-status-select"
import type { CoverLetterSummary } from "@/lib/cover-letters/list-cover-letters"
import type { PostingView } from "@/lib/postings/list-postings"
import { TableCell, TableRow } from "@workspace/ui/components/table"

/**
 * One advertisement, as a row.
 *
 * A server component that takes only strings — every `Date` was formatted in
 * `lib/postings/list-postings.ts`. See `components/documents/document-list.tsx`
 * for why that boundary matters: a `Date` formatted in the browser uses the
 * browser's locale and timezone, and React reports the disagreement as a
 * hydration mismatch rather than as the timezone bug it is.
 *
 * **This is where the client boundary sits.** The row itself renders on the
 * server; the status control and the detail dialog are client components, and
 * they are the only interactive things on it.
 *
 * **The row carries only what is worth scanning, and that is what lets it be a
 * table rather than a stack of cards.** The summary, the highlights copied from
 * the advertisement, why it matched, and all three Cover Letter controls live in
 * `posting-detail-dialog.tsx`, which the title opens. The whole `PostingView`
 * goes to it as props — the page already holds every field, so opening the
 * detail costs no query.
 */
export function PostingRow({
  posting,
  letter,
}: {
  posting: PostingView
  /** The letter already drafted for this Posting, if there is one. */
  letter?: CoverLetterSummary
}) {
  return (
    <TableRow>
      <TableCell className="max-w-xs font-medium">
        {/*
          The title opens the detail rather than the advertisement. The link out
          to the job board lives inside the dialog — one click further in, and
          the only place a click leaves the app, which is what makes clicking a
          Posting mean one thing.
        */}
        <PostingDetailDialog posting={posting} letter={letter} />

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

          It stays on the row rather than moving into the dialog: it is the one
          interaction worth having without opening anything, and the column it
          sits under is sortable.
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
          editing and downloading are all in the dialog now. The column is worth
          keeping because "have I written to this one yet" is a scanning
          question, and answering it per row is what stops the user opening
          twenty-five dialogs to find out.
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
  )
}
