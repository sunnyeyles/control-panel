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
import { EditTailoredResumeButton } from "@/components/briefings/edit-tailored-resume-button"
import { GenerateTailoredResumeButton } from "@/components/briefings/generate-tailored-resume-button"
import { PostingStatusSelect } from "@/components/briefings/posting-status-select"
import { TailoredResumeDownloadLink } from "@/components/briefings/tailored-resume-download-link"
import { TailoredResumePdfButton } from "@/components/briefings/tailored-resume-pdf-button"
import {
  useTailoredResume,
  type TailoredResumePromise,
} from "@/components/briefings/use-tailored-resume"
import { coverLetterFilename } from "@/lib/cover-letters/cover-letter-ref"
import type { PostingView } from "@/lib/postings/list-postings"
import type { PostingDetailView } from "@/lib/postings/load-posting-detail"
import { tailoredResumeFilename } from "@/lib/tailored-resumes/tailored-resume-ref"
import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * One row's detail, as the table body holds it.
 *
 * Lives here rather than beside the fetch because this is the component the
 * three states are *for*: the panel renders one branch each, and a fourth state
 * would have to earn a branch here to exist at all.
 */
export type PostingDetailState =
  | { status: "loading" }
  | { status: "ready"; view: PostingDetailView }
  | { status: "failed"; message: string }

/**
 * One advertisement in full, shown in the expanded table row beneath it.
 *
 * The compact row carries only what is worth scanning — title, company,
 * location, when the advertisement was posted, and whether a letter exists.
 * Everything a row has no width for lives here: the status control, the summary,
 * the highlights copied from the advertisement, why it matched, which Briefing
 * found it, both sighting times, all three Cover Letter controls, and the
 * Tailored Resume controls beneath them.
 *
 * ⚠️ **Most of this costs no round trip; the advertisement's own words do.**
 * The link, the status control, the sighting times and the letter controls all
 * come from the {@link PostingView} the page already holds. The summary, the
 * highlights and the match reason arrive as {@link PostingDetailView}, fetched
 * by the row above when it was expanded — they are the largest fields a Posting
 * has and at most one row is open, so shipping them for all twenty-five was a
 * page of prose in every navigation that nobody read. See
 * `lib/postings/load-posting-detail.ts`.
 *
 * Opening a document for editing has always worked this way:
 * {@link EditCoverLetterButton} and {@link EditTailoredResumeButton} fetch the
 * body on demand into the shared `FileEditorDialog`, so the table never
 * server-renders anyone's markdown.
 *
 * ⚠️ **Every letter and resume control lives here, together.** Editing either is
 * offered nowhere else in the app, so leaving it behind when moving generation
 * would delete the editor, and nothing would fail to compile to say so. The
 * status select is in the same position: this is the only place in the app it is
 * rendered, and the only caller of `setPostingStatusAction`.
 *
 * ⚠️ **The Tailored Resume has no table column, and the Cover Letter does.**
 * "Have I written to this one yet" is a question worth scanning a page for;
 * "have I tailored my CV for this one" is asked once you are already reading a
 * Posting. A sixth column would narrow the five that carry the advertisement.
 *
 * `"use client"` is explicit rather than inherited. The file was always in the
 * client bundle — the table body imports it — and it now calls a hook, so the
 * directive states what was already true.
 */
export function PostingDetail({
  posting,
  detail,
  letters,
  tailoredResumes,
}: {
  posting: PostingView
  /**
   * The advertisement's own words, fetched when this row was expanded.
   *
   * ⚠️ **Three states, and `failed` is not `loading`.** A request that never
   * comes back would otherwise leave a skeleton pulsing forever, which reads as
   * "still working" rather than as "this did not load" — so the failure carries
   * a message and says so. Everything on this panel that needs no request is
   * rendered under all three.
   */
  detail: PostingDetailState
  /**
   * Every letter on this page, still in flight.
   *
   * The same promise the compact rows read, consumed the same way and behind
   * its own boundary. By the time a detail is open it has almost always
   * resolved, so the skeleton below is rarely seen — but a detail opened during
   * the first paint must not block the panel it sits in.
   */
  letters: CoverLetterPromise
  /**
   * Every tailored resume this user has, still in flight.
   *
   * A **second** promise rather than one merged object, because the two loads
   * fail independently: the letters are twenty-five `HeadObject` calls and this
   * is one `ListObjectsV2`, so one can be unreadable while the other is fine,
   * and each section says so for itself. Merging them would make either failure
   * blank both.
   *
   * Note it is not scoped to this page — see `TailoredResumePromise`.
   */
  tailoredResumes: TailoredResumePromise
}) {
  /**
   * `summary` is absent exactly when the stored payload no longer matched the
   * schema — see `loadPostingDetail()` in `lib/postings/load-posting-detail.ts`,
   * which degrades such a row to empty rather than failing the request.
   * `matchReason` and `highlights` go with it, so one branch covers all three.
   *
   * Distinct from `detail.status === "failed"`, which is the request itself not
   * arriving. A drifted payload is a fact about the row; a failed request is a
   * fact about this moment, and only the second is worth retrying.
   */
  const payloadUnreadable =
    detail.status === "ready" && detail.view.summary === undefined

  return (
    <div className="flex min-w-0 flex-col gap-5 py-2 break-words">
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

      {/*
        Three states, not two. The request for this content is made when the row
        is expanded — see `lib/postings/load-posting-detail.ts` for why it is
        not shipped with the row — so "not here yet" is a state of its own, and
        it must not look like "the advertisement carried no description".
      */}
      {detail.status === "loading" ? (
        <div
          aria-busy="true"
          aria-label={`Loading the details for ${posting.title}`}
          className="flex flex-col gap-2"
        >
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </div>
      ) : detail.status === "failed" ? (
        <p className="text-sm text-muted-foreground">
          {detail.message} The advertisement itself still opens above.
        </p>
      ) : payloadUnreadable ? (
        <p className="text-sm text-muted-foreground">
          The details this posting was found with could not be read, so only
          what the table shows is available. The advertisement itself still
          opens above.
        </p>
      ) : (
        <>
          <Section title="Summary">
            <p className="text-sm whitespace-normal">{detail.view.summary}</p>
          </Section>

          {detail.view.highlights.length > 0 ? (
            <Section title="From the advertisement">
              <ul className="list-disc pl-5 text-sm whitespace-normal text-muted-foreground">
                {/*
                  Keyed by position, not by the line itself: highlights are
                  copied from an advertisement and two identical bullets are
                  a thing an advertisement does. The list is never reordered
                  or filtered, so an index is a stable key here.
                */}
                {detail.view.highlights.map((highlight, index) => (
                  <li key={`${posting.id}-${index}`}>{highlight}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Why it matched">
            <p className="text-sm whitespace-normal text-muted-foreground">
              {detail.view.matchReason}
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

      {/*
        Its own `<Suspense>`, not shared with the letter's. `use()` suspends the
        whole component that calls it, and the two loads are independent — one
        boundary would hold the letter controls behind a `ListObjectsV2` that has
        nothing to do with them, and vice versa.
      */}
      <Section title="Tailored resume">
        <Suspense fallback={<Skeleton className="h-8 w-56" />}>
          <TailoredResumeControls
            posting={posting}
            tailoredResumes={tailoredResumes}
          />
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

  /*
    Derived from the Posting rather than read off the letter. Both used to be
    fields of `CoverLetterRow`, taken from the letter's stored S3 provenance —
    but the page now learns which Postings have letters from one
    `ListObjectsV2`, and a listing carries no object metadata. See
    `lib/cover-letters/cover-letter-rows.ts`.

    The visible difference is the right way round: a letter drafted when the
    advertisement had a different title downloads under the title on screen,
    rather than the one captured at drafting time. `coverLetterFilename` is the
    same function the drafting path names its object with, so the two cannot
    drift apart.
  */
  const filename = coverLetterFilename({
    postingId: posting.id,
    title: posting.title,
    company: posting.company,
  })

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
          <CoverLetterDownloadLink
            postingId={letter.postingId}
            displayName={posting.title}
            filename={filename}
          />
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
            displayName={posting.title}
            filename={filename}
          />
        ) : null}
      </div>
    </>
  )
}

/**
 * What has been tailored for this Posting, and what can be done about it.
 *
 * The letter's counterpart, holding the same three-state rule for the same
 * reason: with the store unreadable, offering *Generate* would invite someone to
 * spend a model call replacing a document this panel simply could not see.
 *
 * ⚠️ **Every name shown here comes from `posting`, not from storage.** The
 * lookup carries a Posting id and a date and nothing else, because
 * `loadTailoredResumeRows` reads the whole set with one `ListObjectsV2` and a
 * listing carries no user metadata. The title and company the download link and
 * the PDF button need are already on this component's props — the same values,
 * out of Postgres rather than S3.
 *
 * ⚠️ **Two ways to a PDF, and neither is redundant.** The button below makes one
 * from the stored markdown without opening anything; the editor's own *Download
 * PDF* makes one from whatever is on screen, including unsaved edits. Removing
 * the first would mean opening an editor to get a file, and removing the second
 * would mean saving before you could see how an edit prints.
 */
function TailoredResumeControls({
  posting,
  tailoredResumes,
}: {
  posting: PostingView
  tailoredResumes: TailoredResumePromise
}) {
  const lookup = useTailoredResume(posting.id, tailoredResumes)

  if (lookup.state === "unavailable") {
    return (
      <p className="text-sm text-muted-foreground">
        Your tailored resumes could not be loaded, so whether one has already
        been generated for this posting is unknown. Try again in a moment.
      </p>
    )
  }

  const resume = lookup.state === "generated" ? lookup.resume : undefined

  return (
    <>
      {resume ? (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>Generated {resume.generatedAt}.</span>
          <TailoredResumeDownloadLink
            postingId={posting.id}
            title={posting.title}
            company={posting.company}
          />
          <TailoredResumePdfButton
            postingId={posting.id}
            title={posting.title}
            company={posting.company}
          />
        </p>
      ) : (
        // Said once, where the decision is made, rather than in the page-level
        // paragraph above the table: a tailored resume is a rearrangement of a
        // document the user wrote, and the one failure mode worth naming is the
        // model quietly adding something. Reading it against the original is
        // the whole of what the user has to do about that.
        <p className="text-sm text-muted-foreground">
          Rewrites the newest document you have labelled <em>Resume</em> for
          this advertisement — reordering and re-emphasising what is already in
          it, never adding to it. Read the result against your own CV before you
          send it.
        </p>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <GenerateTailoredResumeButton
          postingId={posting.id}
          title={posting.title}
          generated={resume !== undefined}
        />

        {/*
          Conditional for the reason the download link is: with nothing
          generated there is nothing to edit, and the editor would open on an
          empty document.
        */}
        {resume ? (
          <EditTailoredResumeButton
            postingId={posting.id}
            displayName={posting.title}
            filename={tailoredResumeFilename({
              postingId: posting.id,
              title: posting.title,
              company: posting.company,
            })}
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
