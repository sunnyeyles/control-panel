import type { CoverLetterSummary } from "@/lib/cover-letters/list-cover-letters"

/**
 * The letters this user has drafted, newest first.
 *
 * A server component that takes only strings — every `Date` was formatted in
 * `lib/cover-letters/list-cover-letters.ts`. See
 * `components/documents/document-list.tsx` for why that boundary matters: a
 * `Date` formatted in the browser uses the browser's locale and timezone, and
 * React reports the disagreement as a hydration mismatch rather than as the
 * timezone bug it is.
 *
 * **There is nothing in this list but downloading.** No redraft with
 * instructions, no tone, no send. A letter is drafted from a Posting on the
 * cards below and edited there too — the card owns both actions, because both
 * need the Posting the letter was written for. This is where it can be taken
 * away as a file.
 */
export function CoverLetterList({
  letters,
}: {
  letters: readonly CoverLetterSummary[]
}) {
  if (letters.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No cover letters yet. Draft one from a posting below and it will
          appear here.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {letters.map((letter) => (
        <li
          key={letter.postingId}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-4"
        >
          <div className="flex flex-col gap-1">
            {/*
              The advertisement, when provenance recorded one — a plain anchor,
              not `next/link`, because it leaves the app entirely and prefetching
              a third party's job board is neither useful nor ours to do.
            */}
            {letter.url ? (
              <a
                href={letter.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium underline underline-offset-4 hover:no-underline"
              >
                {letter.displayName}
              </a>
            ) : (
              // A letter drafted before provenance existed, or one whose
              // metadata could not be read, still names *something* and still
              // downloads. The digest is a poor label and a correct one.
              <span className="font-medium">{letter.displayName}</span>
            )}

            <p className="text-sm text-muted-foreground">
              {letter.company ? `${letter.company} — ` : null}
              Drafted {letter.draftedAt}
            </p>
          </div>

          <CoverLetterDownloadLink letter={letter} />
        </li>
      ))}
    </ul>
  )
}

/**
 * A plain anchor with `download`, not `next/link` — the same reasoning as the
 * documents table. Prefetching a download route would have the browser fetch the
 * whole file on hover, and the route answers with an attachment disposition,
 * which is not something the client router can navigate to.
 */
export function CoverLetterDownloadLink({
  letter,
}: {
  letter: CoverLetterSummary
}) {
  return (
    <a
      href={`/api/cover-letters/${letter.postingId}`}
      download={letter.filename}
      className="text-sm underline underline-offset-4 hover:no-underline"
    >
      Download
      <span className="sr-only">
        {" "}
        the cover letter for {letter.displayName}
      </span>
    </a>
  )
}
