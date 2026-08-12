"use client"

import { use } from "react"

import type { CoverLetterView } from "@/lib/cover-letters/cover-letter-views"
import { FileTextIcon, TriangleAlertIcon } from "lucide-react"

/**
 * The letters for one page of the table, as the page hands them down.
 *
 * ⚠️ **A promise, not a result, and `null` is not an empty list.** The page no
 * longer awaits the cover letters. `null` means the store could not be read; an
 * empty array means it was read and nothing is drafted. Collapsing the two
 * would tell someone who has written a letter that they have not.
 *
 * An array rather than a `Map` keyed by Posting: this crosses the RSC boundary,
 * where a `Map` is an awkward payload.
 */
export type CoverLetterPromise = Promise<readonly CoverLetterView[] | null>

/** What one row can say about its letter, with "unknown" kept separate. */
export type CoverLetterLookup =
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "drafted"; letter: CoverLetterView }

/**
 * This row's letter, once the page's storage reads have resolved.
 *
 * ⚠️ **`use()` suspends the component that calls it, so where this hook is
 * called decides what waits.** Called in `PostingTableBody` it would put the
 * whole table behind S3. It belongs in a leaf with its own `<Suspense>` —
 * {@link CoverLetterCell}, and the letter section of the expanded detail.
 *
 * A linear scan, not a lookup map: `coverLetterViewsFor` narrows the array to
 * the visible ids, so it is bounded by `PAGE_SIZE`.
 */
export function useCoverLetter(
  postingId: string,
  letters: CoverLetterPromise
): CoverLetterLookup {
  const rows = use(letters)

  if (rows === null) return { state: "unavailable" }

  const letter = rows.find((row) => row.postingId === postingId)

  return letter === undefined ? { state: "none" } : { state: "drafted", letter }
}

/**
 * Whether this Posting has a letter — not what can be done with it.
 *
 * Drafting, editing and downloading live in the expanded detail; "have I
 * written to this one yet" is a scanning question, which is what earns a cell.
 *
 * All three states render a glyph and a distinct screen-reader phrase — an
 * em-dash for "no letter" and one for "could not tell" would be indexed
 * identically by everyone.
 */
export function CoverLetterCell({
  postingId,
  letters,
}: {
  postingId: string
  letters: CoverLetterPromise
}) {
  const lookup = useCoverLetter(postingId, letters)

  if (lookup.state === "unavailable") {
    return (
      <>
        <TriangleAlertIcon
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
        <span className="sr-only">
          Whether a cover letter exists could not be loaded
        </span>
      </>
    )
  }

  if (lookup.state === "none") {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">No cover letter</span>
      </>
    )
  }

  return (
    <>
      <FileTextIcon aria-hidden="true" className="size-4" />
      <span className="sr-only">Cover letter drafted</span>
    </>
  )
}
