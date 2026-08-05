import { CoverLetterDownloadLink } from "@/components/briefings/cover-letter-list"
import { DraftCoverLetterButton } from "@/components/briefings/draft-cover-letter-button"
import { EditCoverLetterButton } from "@/components/briefings/edit-cover-letter-button"
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
 * server; the status control and the three cover-letter controls are client
 * components, and they are the only interactive things on it.
 *
 * ⚠️ **The three letter controls live here as an interim, and ticket 06 moves
 * them.** They came out of the deleted `components/briefings/briefing-list.tsx`,
 * which was the only place any of them was rendered — `EditCoverLetterButton`
 * in particular is rendered nowhere else in the app, so leaving it behind in
 * that deletion would have removed the letter editor entirely. They belong in
 * the Posting detail dialog, which is ticket 06's work; until it lands they are
 * here so that drafting, editing and downloading all still work.
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
          A plain anchor, not `next/link`: this leaves the app entirely, and
          prefetching a third party's job board is neither useful nor ours to
          do. `noreferrer` keeps the board from being told where the click came
          from.
        */}
        <a
          href={posting.url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-4 hover:no-underline"
        >
          {posting.title}
        </a>
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

      <TableCell>
        <div className="flex flex-wrap items-start gap-2">
          {/*
            `runId` is the Run that most recently reported this advertisement.
            The draft action still re-reads the Posting out of that Run's stored
            Findings, so it has to be named — ticket 07 repoints the action at
            `postings.payload` and this prop disappears with it.
          */}
          <DraftCoverLetterButton
            runId={posting.lastSeenRunId}
            postingId={posting.id}
            title={posting.title}
            drafted={letter !== undefined}
          />

          {/*
            Conditional on the letter for the reason the download link is: with
            nothing drafted there is nothing to edit, and the editor would open
            on an empty document.
          */}
          {letter ? (
            <>
              <EditCoverLetterButton
                postingId={letter.postingId}
                displayName={letter.displayName}
                filename={letter.filename}
              />
              <CoverLetterDownloadLink letter={letter} />
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}
