"use client"

import { Skeleton } from "@workspace/ui/components/skeleton"

import type { PostingDetailState } from "@/components/jobs/postings/posting-detail-state"
import { PostingDetailSection } from "@/components/jobs/postings/posting-detail-section"

/**
 * Match reason and gaps from the fetched detail — the prose half of "Match
 * against your resume". The score number stays on the parent (row-derived);
 * this owns the `detail.status` branch so the parent does not.
 */
export function PostingMatchProse({
  postingId,
  detail,
}: {
  postingId: string
  detail: PostingDetailState
}) {
  if (detail.status === "loading") {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full max-w-lg" />
        <Skeleton className="h-4 w-full max-w-sm" />
      </div>
    )
  }

  if (detail.status !== "ready" || !detail.view.match) {
    return null
  }

  const { match } = detail.view

  return (
    <>
      <p className="text-sm whitespace-normal text-muted-foreground">
        {match.reason}
      </p>

      {/*
        An empty list is a real answer — the CV evidenced everything the
        advertisement stated — so the heading only appears when there is
        something under it rather than over the word "none".
      */}
      {match.gaps.length > 0 ? (
        <>
          <p className="text-xs font-medium">
            What the advertisement asks for that your resume does not show
          </p>
          <ul className="list-disc pl-5 text-sm whitespace-normal text-muted-foreground">
            {match.gaps.map((gap, index) => (
              <li key={`${postingId}-gap-${index}`}>{gap}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  )
}

/**
 * The advertisement's own words — Summary, Experience, Highlights, Why it
 * matched — owned as one child so the parent's row-derived bits (score number,
 * status, Seen, document sections) do not each re-branch on `detail.status`.
 *
 * ⚠️ **Three states, not two.** The request is made when the row is expanded —
 * see `lib/postings/load-posting-detail.ts` — so "not here yet" is a state of
 * its own and must not look like "the advertisement carried no description".
 *
 * ⚠️ **`unreadable` is distinct from `failed`.** A drifted payload is a fact
 * about the row; a failed request is a fact about this moment, and only the
 * second is worth retrying.
 */
export function PostingAdvertisementDetail({
  postingId,
  postingTitle,
  detail,
  payloadUnreadable,
}: {
  postingId: string
  postingTitle: string
  detail: PostingDetailState
  payloadUnreadable: boolean
}) {
  if (detail.status === "loading") {
    /*
      ⚠️ **The real section scaffolding, not three bars in a box.** Three bare
      `gap-2` bars were roughly half the height of the headed sections that
      land, so the panel grew under the reader's cursor on every expand. Only
      the two sections that always render are reserved; "From the
      advertisement" is conditional on highlights. The headings are the real
      words — a grey bar where a heading goes is a second thing to move.
    */
    return (
      <>
        <PostingDetailSection title="Summary">
          <div
            aria-busy="true"
            aria-label={`Loading the details for ${postingTitle}`}
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-4 w-full max-w-xl" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </PostingDetailSection>

        <PostingDetailSection title="Why it matched">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full max-w-lg" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
        </PostingDetailSection>
      </>
    )
  }

  if (detail.status === "failed") {
    return (
      <p className="text-sm text-muted-foreground">
        {detail.message} The advertisement itself still opens above.
      </p>
    )
  }

  if (payloadUnreadable) {
    return (
      <p className="text-sm text-muted-foreground">
        The details this posting was found with could not be read, so only what
        the table shows is available. The advertisement itself still opens
        above.
      </p>
    )
  }

  const { view } = detail

  return (
    <>
      <PostingDetailSection title="Summary">
        <p className="text-sm whitespace-normal">{view.summary}</p>
      </PostingDetailSection>

      {/*
        ⚠️ The advertisement's own words, and absent is the ordinary case: the
        producer copies the phrase or leaves the field out, never inferring
        years from the seniority in the title. See `findings.ts`, and
        `experience.ts` for the one path with no model behind it.
      */}
      {view.experience ? (
        <PostingDetailSection title="Experience asked for">
          <p className="text-sm whitespace-normal text-muted-foreground">
            {view.experience}
          </p>
        </PostingDetailSection>
      ) : null}

      {view.highlights.length > 0 ? (
        <PostingDetailSection title="From the advertisement">
          <ul className="list-disc pl-5 text-sm whitespace-normal text-muted-foreground">
            {/*
              Keyed by position, not by the line: two identical bullets are a
              thing an advertisement does, and the list is never reordered or
              filtered, so an index is stable here.
            */}
            {view.highlights.map((highlight, index) => (
              <li key={`${postingId}-${index}`}>{highlight}</li>
            ))}
          </ul>
        </PostingDetailSection>
      ) : null}

      {/*
        Absent for a Posting added by pasting a link: it was matched against no
        criteria, so the section is left out rather than filled with an invented
        sentence. See `StoredPostingSchema`.
      */}
      {view.matchReason ? (
        <PostingDetailSection title="Why it matched">
          <p className="text-sm whitespace-normal text-muted-foreground">
            {view.matchReason}
          </p>
        </PostingDetailSection>
      ) : null}
    </>
  )
}
