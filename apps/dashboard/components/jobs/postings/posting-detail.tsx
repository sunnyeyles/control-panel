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
 * ⚠️ Columns hidden at a breakpoint reappear here, each guarded by the
 * breakpoint of the column it stands in for — hiding is a relocation, and
 * nothing is ever on screen twice. See `PostingColumn.visibility`.
 *
 * ⚠️ The summary, highlights and match reason arrive as {@link PostingDetailView},
 * fetched by the row above on expansion: they are the largest fields a Posting
 * has and at most one row is open. Everything else comes from the
 * {@link PostingView} the page already holds.
 *
 * ⚠️ This is the only place in the app that renders the status select or any
 * letter/resume control, so moving generation elsewhere would silently delete
 * the editors.
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
   * ⚠️ `failed` is a distinct state from `loading`: a request that never comes
   * back would otherwise pulse a skeleton forever, reading as "still working".
   */
  detail: PostingDetailState
  /** Every letter on this page, still in flight; read only behind a boundary. */
  letters: CoverLetterPromise
  /**
   * Every tailored resume on this page, still in flight.
   *
   * A second promise rather than one merged object: the two list different
   * prefixes and fail independently, and merging would blank both on either
   * failure.
   */
  tailoredResumes: TailoredResumePromise
}) {
  /**
   * `summary` is absent exactly when the stored payload no longer matched the
   * schema; `loadPostingDetail()` degrades such a row to empty rather than
   * failing, and `matchReason`/`highlights` go with it. Distinct from
   * `status === "failed"` — a drifted payload is a fact about the row, and only
   * a failed request is worth retrying.
   */
  const payloadUnreadable =
    detail.status === "ready" && detail.view.summary === undefined

  return (
    <div className="flex min-w-0 flex-col gap-5 py-2 break-words">
      {/*
        Only below `md`, where the ~170px Title column clips and its `title`
        tooltip is nothing at all on a touch screen. `aria-hidden` because
        `line-clamp` hides no text from the accessibility tree — the row's own
        cell already reads the full title out.
      */}
      <p aria-hidden="true" className="text-sm font-medium md:hidden">
        {posting.title}
      </p>

      {/*
        A plain anchor, not `next/link`: this leaves the app, and prefetching a
        third party's site is not ours to do. `noreferrer noopener` keeps the
        board from learning where the click came from or reaching back.
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
        The one field on this Posting a person writes, which is why
        `recordPostings` leaves `status` alone on conflict — a re-find must not
        undo an "applied".

        ⚠️ The Status column shows the value read-only; this is the only place
        it can be changed, and the only rendering of it at all below `md`.
      */}
      <PostingDetailSection title="Status">
        <PostingStatusSelect
          postingId={posting.id}
          status={posting.status}
          title={posting.title}
        />
      </PostingDetailSection>

      {/*
        Outside the three-state branch below because the score is a column the
        table already holds — on screen the instant a row opens — while the
        reason and gaps arrive with the fetched detail. Rendered only once
        something has scored the advertisement.
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
            Said every time a score is shown, not once on the page: the number
            reads as a measurement and is a model's judgement.
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
        The columns this viewport is not rendering, and nothing else. Three
        separate breakpoints rather than one, because the columns do not leave
        together — Location and Posted at `md`, Source at `lg` — and hiding the
        pairs as a block would put Source on screen twice between 768 and
        1024px. Same `dl` shape as **Seen** below, deliberately.
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
            The same three branches the cell above draws: `outline` marks a host
            no board in `JOB_BOARDS` claimed, an em-dash means the stored URL
            would not parse. See `lib/postings/posting-source.ts`.
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
 * Split out because it is the only part of the detail that waits: `use()`
 * suspends its whole component, so the rest of the panel paints meanwhile.
 *
 * ⚠️ "Could not be read" is a third state, not a synonym for "none" — offering
 * *Draft* then would invite replacing a letter this panel could not see.
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
    Derived from the Posting, not read off the letter: the page learns which
    Postings have letters from one `ListObjectsV2`, and a listing carries no
    object metadata. The same `coverLetterFilename` the drafting path names its
    object with, so the two cannot drift.
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
 * reason.
 *
 * ⚠️ Every name here comes from `posting`, not storage: `listTailoredResumes`
 * reads with one `ListObjectsV2` and a listing carries no user metadata.
 *
 * ⚠️ Two ways to a PDF, neither redundant: this button renders the stored
 * markdown, the editor's own *Download PDF* renders unsaved edits.
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
          // Said where the decision is made: the one failure mode worth naming
          // is the model quietly adding something the CV does not say.
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
