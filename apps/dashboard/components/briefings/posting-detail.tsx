"use client"

import { Suspense } from "react"

import {
  useCoverLetter,
  type CoverLetterPromise,
} from "@/components/briefings/cover-letter-cell"
import { CoverLetterDownloadLink } from "@/components/briefings/cover-letter-download-link"
import { CreateCoverLetterButton } from "@/components/briefings/create-cover-letter-button"
import { DraftCoverLetterButton } from "@/components/briefings/draft-cover-letter-button"
import { EditCoverLetterButton } from "@/components/briefings/edit-cover-letter-button"
import { PostingStatusSelect } from "@/components/briefings/posting-status-select"
import type { PostingView } from "@/lib/postings/list-postings"
import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * One advertisement in full, shown in the expanded table row beneath it.
 *
 * The compact row carries only what is worth scanning — title, company,
 * location, when the advertisement was posted, and whether a letter exists.
 * Everything a row has no width for lives here: the status control, the summary,
 * the highlights copied from the advertisement, why it matched, which Briefing
 * found it, both sighting times, and all three Cover Letter controls.
 *
 * ⚠️ **Rendering this costs no round trip.** It takes the whole
 * {@link PostingView} as props, which the page already holds. Opening a letter
 * for editing is the opposite: {@link EditCoverLetterButton} fetches the body
 * on demand into the shared `FileEditorDialog`, so the table never
 * server-renders every letter's markdown.
 *
 * ⚠️ **All three letter controls live here, together.** Editing is offered
 * nowhere else in the app, so leaving it behind when moving drafting would
 * delete the letter editor, and nothing would fail to compile to say so. The
 * status select is now in the same position: this is the only place in the app
 * it is rendered, and the only caller of `setPostingStatusAction`.
 *
 * `"use client"` is explicit rather than inherited. The file was always in the
 * client bundle — the table body imports it — and it now calls a hook, so the
 * directive states what was already true.
 */
export function PostingDetail({
  posting,
  letters,
}: {
  posting: PostingView
  /**
   * Every letter on this page, still in flight.
   *
   * The same promise the compact rows read, consumed the same way and behind
   * its own boundary. By the time a detail is open it has almost always
   * resolved, so the skeleton below is rarely seen — but a detail opened during
   * the first paint must not block the panel it sits in.
   */
  letters: CoverLetterPromise
}) {
  /**
   * `summary` is absent exactly when the stored payload no longer matched the
   * schema — see `toView()` in `lib/postings/list-postings.ts`, which degrades
   * such a row to its projected columns rather than dropping it. `matchReason`
   * and `highlights` go with it, so one branch covers all three.
   */
  const detailUnreadable = posting.summary === undefined

  return (
    <div className="flex flex-col gap-5 py-2">
      {/*
        A plain anchor, not `next/link`: this leaves the app entirely, and
        prefetching a third party's advertisement site is neither useful nor ours to
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

      {/*
        The one field on this Posting a person writes. Everything else is
        whatever the last Run that saw the advertisement reported, which is why
        `recordPostings` in `@workspace/db` leaves `status` alone on conflict —
        a re-find must not undo an "applied".

        It sits near the top because it is an action rather than a fact, beside
        the only other one that does not depend on reading further. It moved off
        the compact row when the table narrowed to five columns; a select is a
        wide control to repeat twenty-five times down a page, and Radix sets
        `aria-expanded` on its trigger while open, which tripped the row
        highlight meant for the disclosure chevron.
      */}
      <Section title="Status">
        <PostingStatusSelect
          postingId={posting.id}
          status={posting.status}
          title={posting.title}
        />
      </Section>

      {detailUnreadable ? (
        <p className="text-sm text-muted-foreground">
          The details this posting was found with could not be read, so only
          what the table shows is available. The advertisement itself still
          opens above.
        </p>
      ) : (
        <>
          <Section title="Summary">
            <p className="text-sm whitespace-normal">{posting.summary}</p>
          </Section>

          {posting.highlights.length > 0 ? (
            <Section title="From the advertisement">
              <ul className="list-disc pl-5 text-sm whitespace-normal text-muted-foreground">
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
            <p className="text-sm whitespace-normal text-muted-foreground">
              {posting.matchReason}
            </p>
          </Section>
        </>
      )}

      <Section title="Seen">
        {/*
          Both sighting times, and the reason this table exists at all: a
          Posting accumulates across Runs, so "found once, weeks ago" and
          "still being re-found this morning" are different things, and only
          these two fields tell them apart.

          Relative here, exact on hover. "3 weeks ago" answers *is this stale*,
          which is the question being asked; the `title` carries the UTC stamp
          for when the answer is not enough. Both strings are formatted on the
          server — see `formatSeenAgo` — because a `Date` formatted in the
          browser uses the browser's locale and zone, and React reports the
          disagreement as a hydration mismatch rather than as the timezone bug
          it is.

          The Briefing is here rather than in a column of its own because it
          is the same kind of fact — provenance of the sighting, not
          something to scan a page of rows for.
        */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <dt>Found by</dt>
          <dd>{posting.briefing}</dd>
          <dt>First seen</dt>
          <dd title={posting.firstSeenExact}>{posting.firstSeen}</dd>
          <dt>Last seen</dt>
          <dd title={posting.lastSeenExact}>{posting.lastSeen}</dd>
        </dl>
      </Section>

      <Section title="Cover letter">
        <Suspense fallback={<Skeleton className="h-8 w-56" />}>
          <CoverLetterControls posting={posting} letters={letters} />
        </Suspense>
      </Section>
    </div>
  )
}

/**
 * What has been drafted for this Posting, and what can be done about it.
 *
 * Split out because it is the only part of the detail that waits on anything:
 * `use()` suspends its whole component, so keeping this separate is what lets
 * the summary, the highlights and the sighting times paint while the page's
 * storage reads are still in flight.
 *
 * ⚠️ **"Could not be read" is a third state, not a synonym for "none".** With
 * the letters unavailable, offering *Draft a cover letter* would invite someone
 * to spend a model call replacing a letter this panel simply could not see. So
 * that case says so and offers nothing — the page-level alert above the table
 * says the same thing once, for the whole page.
 */
function CoverLetterControls({
  posting,
  letters,
}: {
  posting: PostingView
  letters: CoverLetterPromise
}) {
  const lookup = useCoverLetter(posting.id, letters)

  if (lookup.state === "unavailable") {
    return (
      <p className="text-sm text-muted-foreground">
        Your cover letters could not be loaded, so whether one has already been
        written for this posting is unknown. Try again in a moment.
      </p>
    )
  }

  const letter = lookup.state === "drafted" ? lookup.letter : undefined

  return (
    <>
      {/*
        A Posting with a letter says so, and offers the letter. Without
        this the detail offers a *first* draft for something already
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

        {!letter ? (
          <CreateCoverLetterButton
            postingId={posting.id}
            title={posting.title}
          />
        ) : null}

        {/*
          Conditional on the letter for the reason the download link is:
          with nothing drafted there is nothing to edit, and the editor
          would open on an empty document.

          Edit opens `FileEditorDialog` — the shared rich-text editor —
          after fetching `/api/cover-letters/[postingId]`. That identity is
          exactly what this table is keyed on.
        */}
        {letter ? (
          <EditCoverLetterButton
            postingId={letter.postingId}
            displayName={letter.displayName}
            filename={letter.filename}
          />
        ) : null}
      </div>
    </>
  )
}

/**
 * A labelled block of the detail.
 *
 * A heading per section rather than an undifferentiated stack of paragraphs:
 * the summary, the copied highlights and the reason it matched come from three
 * different places and read as one wall of text without labels.
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
