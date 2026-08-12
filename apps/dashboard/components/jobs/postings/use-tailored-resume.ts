"use client"

import { use } from "react"

import type { TailoredResumeView } from "@/lib/tailored-resumes/tailored-resume-views"

/**
 * The types and the hook the tailored-resume controls read, and nothing else.
 *
 * ⚠️ **No `TailoredResumeCell`, unlike `cover-letter-cell.tsx` — there is no
 * column.** "Have I tailored my CV for this one" is asked once you are already
 * looking at a Posting, so a sixth column would only narrow the five carrying
 * the advertisement. Hence a `.ts` named for its hook, not a component module.
 */

/**
 * The tailored resumes for one page of Postings, as the page hands them down.
 *
 * ⚠️ **A promise, not a result, and `null` is not an empty list.** `null` means
 * the store could not be read; an empty array means it was read and this page
 * has none. Collapsing them would offer to spend a model call replacing a
 * document nothing could see.
 *
 * Bounded by the page size: list the user early, filter with
 * `tailoredResumeViewsFor` once the posting ids are known.
 */
export type TailoredResumePromise = Promise<
  readonly TailoredResumeView[] | null
>

/** What one Posting can say about its resume, with "unknown" kept separate. */
export type TailoredResumeLookup =
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "generated"; resume: TailoredResumeView }

/**
 * This Posting's tailored resume, once the page's storage read has resolved.
 *
 * ⚠️ **`use()` suspends the component that calls it, so where this hook is
 * called decides what waits.** Called in `PostingTableBody` it would put the
 * whole table behind S3. It belongs in a leaf with its own `<Suspense>` — the
 * tailored resume section of the expanded detail, and nowhere else today.
 *
 * A linear scan, not a lookup map: the array is bounded by `PAGE_SIZE`.
 */
export function useTailoredResume(
  postingId: string,
  resumes: TailoredResumePromise
): TailoredResumeLookup {
  const rows = use(resumes)

  if (rows === null) return { state: "unavailable" }

  const resume = rows.find((row) => row.postingId === postingId)

  return resume === undefined
    ? { state: "none" }
    : { state: "generated", resume }
}
