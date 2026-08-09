"use client"

import { use } from "react"

import type { CoverLetterRow } from "@/lib/cover-letters/cover-letter-rows"
import { FileTextIcon, TriangleAlertIcon } from "lucide-react"

/**
 * The letters for one page of the table, as the page hands them down.
 *
 * ⚠️ **A promise, not a result, and `null` is not an empty list.** The page no
 * longer awaits the cover letters — see `app/(app)/jobs/page.tsx`. `null`
 * means the store could not be read; an empty array means it was read and this
 * user has drafted nothing. Collapsing the two would tell someone who has
 * already written a letter that they have not, which is the exact failure the
 * page-level alert exists to prevent.
 *
 * An array rather than a `Map` keyed by Posting, because this crosses the RSC
 * boundary and a `Map` is an awkward payload.
 */
export type CoverLetterPromise = Promise<readonly CoverLetterRow[] | null>

/** What one row can say about its letter, with "unknown" kept separate. */
export type CoverLetterLookup =
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "drafted"; letter: CoverLetterRow }

/**
 * This row's letter, once the page's storage reads have resolved.
 *
 * ⚠️ **`use()` suspends the component that calls it, so where this hook is
 * called decides what waits.** Called in `PostingTableBody` it would put the
 * entire table behind S3 and undo the reason the page stopped awaiting these at
 * all. It belongs in a leaf with its own `<Suspense>` boundary — {@link
 * CoverLetterCell} below, and the letter section of the expanded detail.
 *
 * A linear scan, not a lookup map. The array holds letters for the visible page
 * only — `coverLetterRowsFor` narrows the listing to exactly the ids being
 * rendered — so it is bounded by `PAGE_SIZE` and cannot grow with a user's
 * drafting history.
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
 * Drafting, editing and downloading live in the expanded detail. The column is
 * worth a cell of its own because "have I written to this one yet" is a scanning
 * question, and answering it per row is what stops someone opening twenty-five
 * details to find out.
 *
 * All three states render a glyph and a screen-reader phrase, and the three
 * phrases are different on purpose. An em-dash for "no letter" and an em-dash
 * for "we could not tell" would look identical to a sighted reader and read
 * identically to everyone else.
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
