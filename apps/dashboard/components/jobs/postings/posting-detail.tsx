"use client"

import { Suspense } from "react"

import {
  PostingAdvertisementDetail,
  PostingMatchProse,
} from "@/components/jobs/postings/posting-advertisement-detail"
import {
  useCoverLetter,
  type CoverLetterPromise,
} from "@/components/jobs/postings/cover-letter-cell"
import { CoverLetterDownloadLink } from "@/components/jobs/postings/cover-letter-download-link"
import { CreateCoverLetterButton } from "@/components/jobs/postings/create-cover-letter-button"
import { DraftCoverLetterButton } from "@/components/jobs/postings/draft-cover-letter-button"
import { EditCoverLetterButton } from "@/components/jobs/postings/edit-cover-letter-button"
import { EditTailoredResumeButton } from "@/components/jobs/postings/edit-tailored-resume-button"
import { GenerateTailoredResumeButton } from "@/components/jobs/postings/generate-tailored-resume-button"
import { PostingDetailSection } from "@/components/jobs/postings/posting-detail-section"
import type { PostingDetailState } from "@/components/jobs/postings/posting-detail-state"
import { PostingDocumentSection } from "@/components/jobs/postings/posting-document-section"
import { PostingStatusSelect } from "@/components/jobs/postings/posting-status-select"
import { TailoredResumeDownloadLink } from "@/components/jobs/postings/tailored-resume-download-link"
import { TailoredResumePdfButton } from "@/components/jobs/postings/tailored-resume-pdf-button"
import {
  useTailoredResume,
  type TailoredResumePromise,
} from "@/components/jobs/postings/use-tailored-resume"
import { coverLetterFilename } from "@/lib/cover-letters/cover-letter-ref"
import type { PostingView } from "@/lib/postings/list-postings"
import { tailoredResumeFilename } from "@/lib/tailored-resumes/tailored-resume-ref"
import { Badge } from "@workspace/ui/components/badge"
import { Skeleton } from "@workspace/ui/components/skeleton"

export type { PostingDetailState } from "@/components/jobs/postings/posting-detail-state"

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
 * ⚠️ **"What the row has no width for" is a function of the viewport, so part of
 * this panel appears only on a narrow one.** Location, Posted and Source are
 * columns above `lg`, and below it they stop being rendered — see
 * `PostingColumn.visibility`. This panel is where they go, which makes hiding
 * them a relocation rather than a loss; the title comes with them below `md`,
 * where its column is too narrow to finish the sentence. Each of those pieces
 * carries the breakpoint of the column it stands in for, so nothing is ever on
 * screen twice.
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
   * Every tailored resume on this page, still in flight.
   *
   * A **second** promise rather than one merged object, because the two loads
   * fail independently: they list two different prefixes, so one can be
   * unreadable while the other is fine, and each section says so for itself.
   * Merging them would make either failure blank both.
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
        ⚠️ **The title, and only where the row above cannot finish it.** Below
        `md` the Title column is around 170px, so `line-clamp-2` clips most real
        advertisement titles and the `title` attribute that would otherwise
        rescue them is a hover tooltip — nothing at all on a touch screen. Above
        `md` the row is showing the whole thing and this would be it twice.

        `aria-hidden`, because the clipping is purely visual: `line-clamp` hides
        no text from the accessibility tree, so the row's own cell already reads
        the full title out and this copy would be the second time.
      */}
      <p aria-hidden="true" className="text-sm font-medium md:hidden">
        {posting.title}
      </p>

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

        ⚠️ **The row shows the value now, and this is still where it is
        changed.** The Status column renders a read-only badge — see
        `posting-status-badge.tsx` — so this section is no longer the only way to
        find out where an application stands, only the only way to move it. That
        is also why the heading stays: below `md` the column is not rendered and
        this is the whole of it.
      */}
      <PostingDetailSection title="Status">
        <PostingStatusSelect
          postingId={posting.id}
          status={posting.status}
          title={posting.title}
        />
      </PostingDetailSection>

      {/*
        ⚠️ **The score comes from the row, the words behind it come from the
        fetch, and that split is why this section is outside the three-state
        branch below.** `posting.matchScore` is a column on the page the table
        already holds, so the number is on screen the instant a row opens; the
        reason and the gaps are prose and arrive with the rest of the detail —
        see `lib/postings/load-posting-detail.ts`.

        Rendered only once something has scored this advertisement. A Posting
        nobody has scored yet has nothing to say here, and a heading over "not
        yet" would be a section that is empty for every row on a first visit.
      */}
      {posting.matchScore === undefined ? null : (
        <PostingDetailSection title="Match against your resume">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-base font-medium tabular-nums">
              {posting.matchScore}
              <span className="text-muted-foreground"> / 100</span>
            </span>
            {detail.status === "ready" && detail.view.match ? (
              <span className="text-xs text-muted-foreground">
                Scored {detail.view.match.matchedAt}
              </span>
            ) : null}
          </p>

          {/*
            ⚠️ **Said every time a score is shown, not once on the page.** The
            number reads as a measurement and is a model's judgement of one
            document against another; the sentence is what keeps somebody from
            discarding an advertisement on the strength of it.
          */}
          <p className="text-xs text-muted-foreground">
            Read from the newest document you have labelled <em>Resume</em>,
            against what this advertisement states. A judgement, not a
            measurement — and it knows nothing about you that your CV does not
            say.
          </p>

          <PostingMatchProse postingId={posting.id} detail={detail} />
        </PostingDetailSection>
      )}

      {/*
        ⚠️ **The columns this viewport is not rendering, and nothing else.**
        These three are cells of the compact row above `lg` — see
        `PostingColumn.visibility` — so each pair here carries the breakpoint at
        which its own column comes back, and the section carries the widest of
        them. Above `lg` the whole thing is gone rather than a heading over an
        empty grid.

        Three separate breakpoints and not one, because the columns do not all
        leave together: Location and Posted go at `md`, Source at `lg`. Hiding
        the pairs as a block would put Source on screen twice between 768px and
        1024px.

        The same `dl` as **Seen** below, deliberately: they are the same kind of
        content — labelled single facts — and two grid shapes for that in one
        panel would read as two different things.
      */}
      <PostingDetailSection title="Where and when" className="lg:hidden">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <dt className="md:hidden">Location</dt>
          <dd className="md:hidden">{posting.location}</dd>

          <dt className="md:hidden">Posted</dt>
          <dd className="md:hidden">
            {posting.postedAt ?? (
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Posting date not stated</span>
              </>
            )}
          </dd>

          {/*
            The same three branches the cell above draws, and for the same
            reason: `outline` marks a host no board in `JOB_BOARDS` claimed, and
            an em-dash means the stored URL would not parse at all. A panel that
            collapsed those into one would make a board missing from the
            registry invisible on precisely the viewport where the column that
            reveals it is not rendered. See `lib/postings/posting-source.ts`.
          */}
          <dt className="lg:hidden">Source</dt>
          <dd className="lg:hidden">
            {posting.source ? (
              <Badge
                variant={posting.source.recognised ? "secondary" : "outline"}
              >
                {posting.source.label}
              </Badge>
            ) : (
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Source not recognised</span>
              </>
            )}
          </dd>
        </dl>
      </PostingDetailSection>

      <PostingAdvertisementDetail
        postingId={posting.id}
        postingTitle={posting.title}
        detail={detail}
        payloadUnreadable={payloadUnreadable}
      />

      <PostingDetailSection title="Seen">
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
      </PostingDetailSection>

      <PostingDetailSection title="Cover letter">
        <Suspense fallback={<Skeleton className="h-8 w-56" />}>
          <CoverLetterControls posting={posting} letters={letters} />
        </Suspense>
      </PostingDetailSection>

      {/*
        Its own `<Suspense>`, not shared with the letter's. `use()` suspends the
        whole component that calls it, and the two loads are independent — one
        boundary would hold the letter controls behind a `ListObjectsV2` that has
        nothing to do with them, and vice versa.
      */}
      <PostingDetailSection title="Tailored resume">
        <Suspense fallback={<Skeleton className="h-8 w-56" />}>
          <TailoredResumeControls
            posting={posting}
            tailoredResumes={tailoredResumes}
          />
        </Suspense>
      </PostingDetailSection>
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
      <PostingDocumentSection
        unavailable={
          <p className="text-sm text-muted-foreground">
            Your cover letters could not be loaded, so whether one has already
            been written for this posting is unknown. Try again in a moment.
          </p>
        }
        actions={null}
      />
    )
  }

  const letter = lookup.state === "drafted" ? lookup.letter : undefined

  /*
    Derived from the Posting rather than read off the letter. Both used to be
    fields of `CoverLetterView`, taken from the letter's stored S3 provenance —
    but the page now learns which Postings have letters from one
    `ListObjectsV2`, and a listing carries no object metadata. See
    `lib/cover-letters/cover-letter-views.ts`.

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
    <PostingDocumentSection
      existing={
        letter ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
            <span>Drafted {letter.draftedAt}.</span>
            <CoverLetterDownloadLink
              postingId={letter.postingId}
              displayName={posting.title}
              filename={filename}
            />
          </p>
        ) : undefined
      }
      actions={
        <>
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

          {letter ? (
            <EditCoverLetterButton
              postingId={letter.postingId}
              displayName={posting.title}
              filename={filename}
            />
          ) : null}
        </>
      }
    />
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
 * `listTailoredResumes` reads with one `ListObjectsV2` and a listing carries
 * no user metadata. The title and company the download link and the PDF button
 * need are already on this component's props — the same values, out of
 * Postgres rather than S3.
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
      <PostingDocumentSection
        unavailable={
          <p className="text-sm text-muted-foreground">
            Your tailored resumes could not be loaded, so whether one has
            already been generated for this posting is unknown. Try again in a
            moment.
          </p>
        }
        actions={null}
      />
    )
  }

  const resume = lookup.state === "generated" ? lookup.resume : undefined

  return (
    <PostingDocumentSection
      existing={
        resume ? (
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
        ) : undefined
      }
      emptyHint={
        resume ? undefined : (
          // Said once, where the decision is made, rather than in the page-level
          // paragraph above the table: a tailored resume is a rearrangement of a
          // document the user wrote, and the one failure mode worth naming is the
          // model quietly adding something. Reading it against the original is
          // the whole of what the user has to do about that.
          <p className="text-sm text-muted-foreground">
            Rewrites the newest document you have labelled <em>Resume</em> for
            this advertisement — reordering and re-emphasising what is already
            in it, never adding to it. Read the result against your own CV
            before you send it.
          </p>
        )
      }
      actions={
        <>
          <GenerateTailoredResumeButton
            postingId={posting.id}
            title={posting.title}
            generated={resume !== undefined}
          />

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
        </>
      }
    />
  )
}
