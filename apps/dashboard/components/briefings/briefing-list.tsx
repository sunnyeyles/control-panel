import type {
  BriefingPostings,
  LatestFindings,
  PostingView,
} from "@/lib/briefings/latest-postings"
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
}: {
  briefings: readonly BriefingPostings[]
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
        <BriefingCard key={briefing.briefingId} briefing={briefing} />
      ))}
    </div>
  )
}

function BriefingCard({ briefing }: { briefing: BriefingPostings }) {
  const { latest } = briefing

  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{briefing.briefingName}</h2>
        <p className="text-sm text-muted-foreground">
          {latest.state === "no-run"
            ? "Not run yet"
            : `Last run ${latest.ranAt}`}
        </p>
      </div>

      {latest.state === "recorded" && latest.notes ? (
        <p className="text-sm text-muted-foreground">{latest.notes}</p>
      ) : null}

      {latest.state === "recorded" && latest.postings.length > 0 ? (
        <ol className="flex flex-col gap-4">
          {latest.postings.map((posting) => (
            <li key={posting.id}>
              <PostingCard posting={posting} />
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

function PostingCard({ posting }: { posting: PostingView }) {
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
    </article>
  )
}
