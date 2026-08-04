import { CoverLetterDownloadLink } from "@/components/briefings/cover-letter-list"
import { DraftCoverLetterButton } from "@/components/briefings/draft-cover-letter-button"
import { EditCoverLetterButton } from "@/components/briefings/edit-cover-letter-button"
import { RunActivityStatus } from "@/components/briefings/run-activity-status"
import { RunNowButton } from "@/components/briefings/run-now-button"
import type { RunActivity } from "@/lib/briefing-runs/run-activity"
import type {
  BriefingPostings,
  LatestFindings,
  PostingView,
} from "@/lib/briefings/latest-postings"
import type { CoverLetterSummary } from "@/lib/cover-letters/list-cover-letters"
import { Badge } from "@workspace/ui/components/badge"

/**
 * What a briefing's latest Run found.
 *
 * A server component, and it takes only strings: every `Date` was formatted in
 * `lib/briefings/latest-postings.ts`. See `components/documents/document-list.tsx`
 * for why that boundary matters — a `Date` formatted in the browser uses the
 * browser's locale and timezone, and React reports the disagreement as a
 * hydration mismatch rather than as the timezone bug it is.
 *
 * Every branch below that says "nothing" is an empty state rather than an
 * error. A Run that found no Postings ran correctly and found no Postings.
 */
export function BriefingList({
  briefings,
  letters,
  activity,
}: {
  briefings: readonly BriefingPostings[]
  /**
   * What each briefing's most recent Run is doing, keyed by briefing id.
   *
   * Keyed for the reason `letters` is, and optional for the same reason too:
   * the page loads it independently and a failure there degrades to cards with
   * no status rather than to no page.
   */
  activity?: ReadonlyMap<string, RunActivity>
  /**
   * The letters this user has already drafted, keyed by Posting id.
   *
   * Keyed rather than a list because the question each card asks is "is there
   * one for *this* Posting", and a linear scan per card would make the page
   * quadratic in a user's drafting history for no reason. Empty when the letters
   * could not be read — a storage failure degrades to the pre-#85 behaviour
   * rather than removing the postings from the page.
   */
  letters?: ReadonlyMap<string, CoverLetterSummary>
}) {
  if (briefings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No briefings yet. Create one in Settings and its postings will appear
          here after it runs.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {briefings.map((briefing) => (
        <BriefingCard
          key={briefing.briefingId}
          briefing={briefing}
          letters={letters}
          activity={activity?.get(briefing.briefingId)}
        />
      ))}
    </div>
  )
}

function BriefingCard({
  briefing,
  letters,
  activity,
}: {
  briefing: BriefingPostings
  letters?: ReadonlyMap<string, CoverLetterSummary>
  activity?: RunActivity
}) {
  const { latest } = briefing

  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{briefing.briefingName}</h2>
          {/*
            The *latest* Run, whatever became of it — not the latest successful
            one, which is what `latest` below describes. When the newest Run
            failed or is still going those are different rows, and that is
            exactly when someone needs to be told: the postings underneath are
            still the last ones that worked, and saying so is more honest than
            showing a success time for a Run that failed.
          */}
          <RunActivityStatus activity={activity ?? { state: "never-run" }} />
        </div>

        <RunNowButton
          briefingId={briefing.briefingId}
          briefingName={briefing.briefingName}
          running={activity?.state === "running"}
        />
      </div>

      {latest.state === "recorded" ? (
        <p className="text-sm text-muted-foreground">
          Found {latest.ranAt}
          {latest.notes ? ` — ${latest.notes}` : ""}
        </p>
      ) : null}

      {latest.state === "recorded" && latest.postings.length > 0 ? (
        <ol className="flex flex-col gap-4">
          {latest.postings.map((posting) => (
            <li key={posting.id}>
              {/*
                The Run id is threaded down rather than looked up in the card:
                a Posting has no Run of its own, and the letter's storage key
                holds no Run either. It travels only so the action can be told
                which Findings to re-read the Posting out of — and it is checked
                for ownership there, never trusted.
              */}
              <PostingCard
                posting={posting}
                runId={latest.runId}
                letter={letters?.get(posting.id)}
              />
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {emptyMessage(latest.state)}
          </p>
        </div>
      )}
    </section>
  )
}

function emptyMessage(state: LatestFindings["state"]): string {
  switch (state) {
    case "no-run":
      return "This briefing has not completed a run yet."

    case "not-recorded":
      // Every run from before `runs.findings` existed lands here, so this is a
      // fallback the user will genuinely see rather than a defensive branch.
      return "That run did not keep a record of what it found."

    case "unreadable":
      return "That run's findings could not be read."

    case "recorded":
      // A legitimate result: the scout searched and nothing matched.
      return "That run found no postings."

    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function PostingCard({
  posting,
  runId,
  letter,
}: {
  posting: PostingView
  runId: string
  /** The letter already drafted for this Posting, if there is one. */
  letter?: CoverLetterSummary
}) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
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
          className="font-medium underline underline-offset-4 hover:no-underline"
        >
          {posting.title}
        </a>
        {posting.postedAt ? (
          <Badge variant="outline">{posting.postedAt}</Badge>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">
        {posting.company} — {posting.location}
      </p>

      <p className="text-sm">{posting.summary}</p>

      {posting.highlights.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {/*
            Keyed by position, not by the line itself: highlights are copied
            from an advertisement and two identical bullets are a thing an
            advertisement does. The list is never reordered or filtered, so an
            index is a stable key here.
          */}
          {posting.highlights.map((highlight, index) => (
            <li key={`${posting.id}-${index}`}>{highlight}</li>
          ))}
        </ul>
      ) : null}

      <p className="text-sm text-muted-foreground">{posting.matchReason}</p>

      {/*
        A Posting with a letter says so, and offers the letter. Without this the
        card offers a *first* draft for something already drafted, which is the
        one thing a user cannot tell from the button alone — and it would take
        clicking it, and spending a model call, to find out.
      */}
      {letter ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
          <span>Cover letter drafted {letter.draftedAt}.</span>
          <CoverLetterDownloadLink letter={letter} />
        </p>
      ) : null}

      {/*
        A row, so the two actions on a drafted Posting read as alternatives to
        each other — replace what the model wrote, or edit it. The draft button
        renders its own column (a form stacked over its alert), which nests
        inside this row unchanged.
      */}
      <div className="flex flex-wrap items-start gap-2">
        <DraftCoverLetterButton
          runId={runId}
          postingId={posting.id}
          title={posting.title}
          drafted={letter !== undefined}
        />

        {/*
          Conditional on the letter for the same reason the download link above
          is: with nothing drafted there is nothing to edit, and the editor
          would open on an empty document.
        */}
        {letter ? (
          <EditCoverLetterButton
            postingId={letter.postingId}
            displayName={letter.displayName}
            filename={letter.filename}
          />
        ) : null}
      </div>
    </article>
  )
}
