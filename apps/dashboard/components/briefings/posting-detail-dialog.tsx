"use client"

import { CoverLetterDownloadLink } from "@/components/briefings/cover-letter-list"
import { DraftCoverLetterButton } from "@/components/briefings/draft-cover-letter-button"
import { EditCoverLetterButton } from "@/components/briefings/edit-cover-letter-button"
import type { CoverLetterSummary } from "@/lib/cover-letters/list-cover-letters"
import type { PostingView } from "@/lib/postings/list-postings"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"

/**
 * One advertisement in full, opened from its row.
 *
 * The table row carries only what is worth scanning — title, company, location,
 * status, the two sighting times. Everything the superseded Posting card
 * rendered and a row has no width for lives here: the summary, the highlights
 * copied from the advertisement, why it matched the user's criteria, which
 * Briefing found it, when it was first and last seen, and all three Cover
 * Letter controls.
 *
 * ⚠️ **Opening this costs no round trip, and that is a decision rather than an
 * oversight — do not "optimise" it into a fetch.** It takes the whole
 * {@link PostingView} as props, which the page already holds: `listPostings()`
 * read every field for the row it is rendering beside, and formatted both dates
 * to strings on the server. A page of twenty-five summaries is single-digit
 * kilobytes of RSC payload. The alternative — a detail route, or a client fetch
 * — buys those kilobytes back at the price of a second query for data already
 * in memory, a loading state inside the dialog, and a failure mode where the
 * row renders and its detail does not.
 *
 * ⚠️ **All three letter controls live here, together.**
 * `DraftCoverLetterButton`, `EditCoverLetterButton` and
 * `CoverLetterDownloadLink` came out of the deleted Posting card by way of an
 * interim stop on `posting-row.tsx`. **Editing is offered nowhere else in the
 * app** — the "Your cover letters" listing beneath the table carries download
 * links only — so moving drafting here and leaving editing behind would delete
 * the letter editor, and nothing would fail to compile to say so.
 *
 * **The open/closed state is local, deliberately not the URL.** Closing must
 * return to the same page of the same sort at the same scroll position, and a
 * `?posting=` parameter would make every open and close a navigation — the one
 * thing the sort headers and the pagination links are careful to keep cheap.
 *
 * **Keyboard behaviour is Radix's, and the trigger is why it works.** The
 * trigger is rendered by this component rather than passed in, so `Dialog`
 * records the element to restore focus to: focus moves into the content on
 * open, is trapped while it is open, `Escape` and the close button both
 * dismiss, and focus returns to the title button that opened it. Nothing here
 * overrides `onOpenChange`, `onEscapeKeyDown` or `onInteractOutside`, which is
 * what keeps that intact.
 */
export function PostingDetailDialog({
  posting,
  letter,
}: {
  posting: PostingView
  /**
   * The letter already drafted for this Posting, if there is one.
   *
   * The whole summary rather than the three fields the controls need, because
   * `CoverLetterDownloadLink` takes one. Its `draftedOn` is a `Date` and is
   * deliberately never read here — `draftedAt` was formatted on the server, and
   * formatting an instant in the browser uses the visitor's locale and
   * timezone, which React reports as a hydration mismatch rather than as the
   * timezone bug it is.
   */
  letter?: CoverLetterSummary
}) {
  /**
   * `summary` is absent exactly when the stored payload no longer matched the
   * schema — see `toView()` in `lib/postings/list-postings.ts`, which degrades
   * such a row to its projected columns rather than dropping it. `matchReason`
   * and `highlights` go with it, so one branch covers all three. Saying so is
   * better than the three empty sections the old card rendered.
   */
  const detailUnreadable = posting.summary === undefined

  return (
    <Dialog>
      <DialogTrigger asChild>
        {/*
          The title *is* the trigger: clicking a Posting opens its full detail
          without leaving the table. It reads as a link and is a button, which
          is what it is — nothing is navigated to. The advertisement itself is
          one click further in, below.
        */}
        <button
          type="button"
          className="rounded-sm text-left font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {posting.title}
          <span className="sr-only"> — open this posting&rsquo;s detail</span>
        </button>
      </DialogTrigger>

      {/*
        Wider and scrollable: the default content is `sm:max-w-sm`, which is a
        confirmation prompt's width, and a summary plus a list of highlights is
        neither short nor of predictable length. `max-h` with its own overflow
        keeps a long advertisement inside the dialog instead of pushing the
        letter controls off the bottom of the viewport.
      */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle>{posting.title}</DialogTitle>
          <DialogDescription>
            {posting.company} — {posting.location}
            {posting.postedAt ? ` — posted ${posting.postedAt}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/*
            A plain anchor, not `next/link`: this leaves the app entirely, and
            prefetching a third party's job board is neither useful nor ours to
            do. `noreferrer` keeps the board from being told where the click
            came from, and `noopener` keeps the opened tab from reaching back.
          */}
          <a
            href={posting.url}
            target="_blank"
            rel="noreferrer noopener"
            className="self-start text-sm underline underline-offset-4 hover:no-underline"
          >
            Open the advertisement
            <span className="sr-only"> for {posting.title}, in a new tab</span>
          </a>

          {detailUnreadable ? (
            <p className="text-sm text-muted-foreground">
              The details this posting was found with could not be read, so only
              what the table shows is available. The advertisement itself still
              opens above.
            </p>
          ) : (
            <>
              <Section title="Summary">
                <p className="text-sm">{posting.summary}</p>
              </Section>

              {posting.highlights.length > 0 ? (
                <Section title="From the advertisement">
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {/*
                      Keyed by position, not by the line itself: highlights are
                      copied from an advertisement and two identical bullets are
                      a thing an advertisement does. The list is never reordered
                      or filtered, so an index is a stable key here.
                    */}
                    {posting.highlights.map((highlight, index) => (
                      <li key={`${posting.id}-${index}`}>{highlight}</li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              <Section title="Why it matched">
                <p className="text-sm text-muted-foreground">
                  {posting.matchReason}
                </p>
              </Section>
            </>
          )}

          <Section title="Seen">
            {/*
              Both sighting times, which is the pair the table splits across two
              columns and the reason this table exists at all: a Posting
              accumulates across Runs, so "found once, weeks ago" and "still
              being re-found this morning" are different things, and only these
              two fields tell them apart.

              The Briefing is here rather than in a column of its own because it
              is the same kind of fact — provenance of the sighting, not
              something to scan a page of rows for. It is stated at all because
              this table is cumulative across *every* Briefing the user has: the
              card this dialog replaced sat inside one, and got the answer for
              free from that card's heading.
            */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <dt>Found by</dt>
              <dd>{posting.briefing}</dd>
              <dt>First seen</dt>
              <dd>{posting.firstSeen}</dd>
              <dt>Last seen</dt>
              <dd>{posting.lastSeen}</dd>
            </dl>
          </Section>

          <Section title="Cover letter">
            {/*
              A Posting with a letter says so, and offers the letter. Without
              this the dialog offers a *first* draft for something already
              drafted, which is the one thing a user cannot tell from the button
              alone — and it would take clicking it, and spending a model call,
              to find out.
            */}
            {letter ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
                <span>Drafted {letter.draftedAt}.</span>
                <CoverLetterDownloadLink letter={letter} />
              </p>
            ) : null}

            {/*
              A row, so the two actions on a drafted Posting read as
              alternatives to each other — replace what the model wrote, or edit
              it. The draft button renders its own column (a form stacked over
              its alert), which nests inside this row unchanged.
            */}
            <div className="flex flex-wrap items-start gap-2">
              <DraftCoverLetterButton
                postingId={posting.id}
                title={posting.title}
                drafted={letter !== undefined}
              />

              {/*
                Conditional on the letter for the reason the download link is:
                with nothing drafted there is nothing to edit, and the editor
                would open on an empty document.

                It opens a second dialog over this one, which Radix stacks: the
                editor takes the focus trap while it is open and hands it back
                here on close. It needs no prop change to live here — it takes a
                `postingId` and fetches `/api/cover-letters/[postingId]`, which
                is exactly the identity this table is keyed on.
              */}
              {letter ? (
                <EditCoverLetterButton
                  postingId={letter.postingId}
                  displayName={letter.displayName}
                  filename={letter.filename}
                />
              ) : null}
            </div>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A labelled block of the detail.
 *
 * A heading per section rather than the card's undifferentiated stack of
 * paragraphs: the summary, the copied highlights and the reason it matched come
 * from three different places and read as one wall of text without labels. `h3`
 * because `DialogTitle` is the heading above them.
 */
function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}
