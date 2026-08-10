"use client"

import { Suspense, use, useActionState, useState, type ReactNode } from "react"

import { deletePostingsAction } from "@/app/(app)/jobs/actions"
import { ActionError } from "@/components/forms/action-error"

import type { CoverLetterPromise } from "@/components/jobs/postings/cover-letter-cell"
import type { TailoredResumePromise } from "@/components/jobs/postings/use-tailored-resume"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * The one confirmation, for both the row's trash icon and the bulk bar.
 *
 * A Posting is a projection of what a Run found, and both documents saved
 * against one — the **Cover Letter** and the **Tailored Resume** — are
 * versioned in S3, so the worst case here is a redraft rather than a loss.
 *
 * One component and not two, because the two entry points differ only in how
 * many ids they carry. Splitting them would put the copy that has to be right —
 * what happens to the documents, and that a run can bring the advertisement
 * back — in two places for someone to update one of.
 */
export function DeletePostingsDialog({
  postingIds,
  postingTitle,
  letters,
  tailoredResumes,
  trigger,
  onDeleted,
}: {
  /** What will be deleted. One id from a row, the selection from the bar. */
  postingIds: readonly string[]
  /** Named in the copy when there is exactly one. */
  postingTitle?: string
  /**
   * ⚠️ **A promise, read only inside {@link DocumentsWarning} behind its own
   * `<Suspense>`.** Reading it here would put opening the dialog behind the
   * page's S3 round trips — the wait `cover-letter-cell.tsx` exists to avoid.
   */
  letters: CoverLetterPromise
  /**
   * The action deletes this document too — `deleteSelected` removes both per
   * Posting — so the warning must count it, or a Posting with a tailored
   * resume and no letter is deleted with no warning at all.
   */
  tailoredResumes: TailoredResumePromise
  trigger: ReactNode
  /** Called once the delete succeeds. The bulk bar clears its selection. */
  onDeleted?: () => void
}) {
  const [open, setOpen] = useState(false)

  // Closing and clearing happen *in the submission*, not in an effect watching
  // the state it produced. An effect would be a second render pass reacting to
  // the first — and would need a key to tell "succeeded again" from "still
  // showing the last success", which is bookkeeping this shape does not need.
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const next = await deletePostingsAction(previous, formData)

      if (next.status === "success") {
        setOpen(false)
        onDeleted?.()
      }

      return next
    },
    IDLE
  )

  const single = postingIds.length === 1

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {single
              ? "Delete this posting?"
              : `Delete ${postingIds.length} postings?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {single
              ? `${postingTitle ?? "This posting"} will be removed from your postings.`
              : `${postingIds.length} postings will be removed from your postings.`}{" "}
            {/*
              Renders nothing while the page's storage reads are still in
              flight, and nothing when there is no document to lose — which is
              what makes the sentence appear only when it is true.
            */}
            <Suspense fallback={null}>
              <DocumentsWarning
                postingIds={postingIds}
                letters={letters}
                tailoredResumes={tailoredResumes}
              />
            </Suspense>{" "}
            {/*
              Said plainly rather than left as a surprise. `recordPostings`
              upserts on `(user_id, posting_id)`, so this is a delete from the
              page and not from the search: a Briefing that still matches the
              advertisement will find it again and add it back at New.
            */}
            {single
              ? "A future briefing run that finds this advertisement again will add it back."
              : "A future briefing run that finds any of these advertisements again will add them back."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form action={formAction}>
          {/*
            One field per id, repeated — the action reads them with `getAll`.
            Untrusted, and validated server-side against the shape a Posting id
            has; what they cannot do is name another user, because the rows are
            addressed by `(session user, posting id)` and the storage key is
            built from the session's own id.
          */}
          {postingIds.map((postingId) => (
            <input
              key={postingId}
              type="hidden"
              name="postingId"
              value={postingId}
            />
          ))}

          <ActionError state={state} className="mb-4" />

          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <SubmitButton
              pending={pending}
              variant="destructive"
              label="Delete"
            />
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * What happens to the documents, as a sentence — or nothing at all.
 *
 * Both stores are counted, because the action deletes both: a cover letter
 * *and* a tailored resume go with each Posting, and a warning that named only
 * the letter would say nothing at all to someone deleting a Posting whose only
 * document is a tailored resume.
 *
 * `null` from either promise means that store could not be read, **not** that
 * it is empty, and guessing either way is worse than staying quiet about it:
 * promising that nothing will be lost is the more damaging guess, and
 * promising a loss that does not happen is merely confusing. The readable
 * store still gets its sentence.
 *
 * A linear scan per store — the letters bounded by `PAGE_SIZE` exactly as
 * `useCoverLetter` is, the resumes by a job search's worth of generations, as
 * `use-tailored-resume.ts` explains.
 */
function DocumentsWarning({
  postingIds,
  letters,
  tailoredResumes,
}: {
  postingIds: readonly string[]
  letters: CoverLetterPromise
  tailoredResumes: TailoredResumePromise
}) {
  const letterRows = use(letters)
  const resumeRows = use(tailoredResumes)

  const drafted = countWithDocument(postingIds, letterRows)
  const tailored = countWithDocument(postingIds, resumeRows)

  if (drafted === 0 && tailored === 0) return null

  return (
    <>
      {documentsClause(drafted, tailored, postingIds.length === 1)}; previous
      versions are retained for a year.
    </>
  )
}

/** How many of the postings being deleted have a row in this store. */
function countWithDocument(
  postingIds: readonly string[],
  rows: readonly { postingId: string }[] | null
): number {
  if (rows === null) return 0

  return postingIds.filter((postingId) =>
    rows.some((row) => row.postingId === postingId)
  ).length
}

/**
 * Three phrasings per shape, because "1 cover letter" reads differently when
 * the user is deleting one posting and when they are deleting nine of which
 * one has a letter.
 */
function documentsClause(
  drafted: number,
  tailored: number,
  single: boolean
): string {
  if (single) {
    if (drafted > 0 && tailored > 0) {
      return "The cover letter and tailored resume saved for it will be removed too"
    }

    return drafted > 0
      ? "The cover letter drafted for it will be removed too"
      : "The tailored resume generated for it will be removed too"
  }

  if (drafted > 0 && tailored > 0) {
    return `${countNoun(drafted, "cover letter")} and ${countNoun(tailored, "tailored resume")} will be removed with them`
  }

  const noun = drafted > 0 ? "cover letter" : "tailored resume"
  const count = drafted > 0 ? drafted : tailored

  return count === 1
    ? `One of them has a ${noun}, which will be removed too`
    : `${count} ${noun}s will be removed with them`
}

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
