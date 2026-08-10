"use client"

import { use } from "react"

import type { TailoredResumeRow } from "@/lib/tailored-resumes/tailored-resume-rows"

/**
 * The types and the hook the tailored-resume controls read, and nothing else.
 *
 * ⚠️ **No `TailoredResumeCell`, unlike `cover-letter-cell.tsx` — there is no
 * column.** "Have I written to this one yet" is a scanning question worth a
 * column; "have I tailored my CV for this one" is asked once you are already
 * looking at a Posting, and a sixth column would narrow the five that carry the
 * advertisement itself. The file is therefore a `.ts` with a hook in it rather
 * than a component module, and it is named for what it exports.
 */

/**
 * The tailored resumes for one user, as the page hands them down.
 *
 * ⚠️ **A promise, not a result, and `null` is not an empty list.** `null` means
 * the store could not be read; an empty array means it was read and this user
 * has generated nothing. Collapsing the two would tell someone who has already
 * generated one that they have not — and would offer to spend a model call
 * replacing a document nothing could see.
 *
 * ⚠️ **This one is not bounded by the page, unlike `CoverLetterPromise`.**
 * `loadTailoredResumeRows` makes a single `ListObjectsV2` call rather than a
 * `HeadObject` per visible row, so what arrives is every tailored resume the
 * user has. That is deliberate — see the function's own comment — and it is why
 * the scan below is described as bounded by a job search rather than by
 * `PAGE_SIZE`.
 */
export type TailoredResumePromise = Promise<readonly TailoredResumeRow[] | null>

/** What one Posting can say about its resume, with "unknown" kept separate. */
export type TailoredResumeLookup =
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "generated"; resume: TailoredResumeRow }

/**
 * This Posting's tailored resume, once the page's storage read has resolved.
 *
 * ⚠️ **`use()` suspends the component that calls it, so where this hook is
 * called decides what waits.** Called in `PostingTableBody` it would put the
 * entire table behind S3 and undo the reason the page does not await this at
 * all. It belongs in a leaf with its own `<Suspense>` boundary — the tailored
 * resume section of the expanded detail, and nowhere else today.
 *
 * A linear scan, not a lookup map: the array is one person's generated resumes,
 * which is a small number and one that grows only when they click the button.
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
