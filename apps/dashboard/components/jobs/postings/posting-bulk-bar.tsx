"use client"

import { DeletePostingsDialog } from "@/components/jobs/postings/delete-postings-dialog"
import type { CoverLetterPromise } from "@/components/jobs/postings/cover-letter-cell"
import type { TailoredResumePromise } from "@/components/jobs/postings/use-tailored-resume"
import { usePostingSelection } from "@/components/jobs/postings/posting-selection"
import { Button } from "@workspace/ui/components/button"
import { Trash2Icon } from "lucide-react"

/**
 * What can be done to the ticked rows, above the table.
 *
 * Above rather than in a column, because a bulk action is about the selection
 * and not about any one row — and because the postings table was deliberately
 * narrowed, so a control that only matters while something is ticked has no
 * claim on horizontal space the rest of the time.
 *
 * The container is always rendered and reserves its own height. Mounting it
 * only when something is ticked would shift the whole table down on the first
 * click and back up on the last, which puts the row someone is aiming at
 * somewhere else between the two.
 */
export function PostingBulkBar({
  letters,
  tailoredResumes,
}: {
  letters: CoverLetterPromise
  tailoredResumes: TailoredResumePromise
}) {
  const { selected, clear } = usePostingSelection()

  return (
    <div className="flex min-h-9 items-center gap-2">
      {selected.length > 0 ? (
        <>
          {/*
            `aria-live`, because the count changes in response to a click
            somewhere else on the page. Polite: a screen reader should finish
            announcing the checkbox before it reports the new total.
          */}
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {selected.length} selected
          </p>

          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>

          <DeletePostingsDialog
            postingIds={selected}
            letters={letters}
            tailoredResumes={tailoredResumes}
            onDeleted={clear}
            trigger={
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="ml-auto"
              >
                <Trash2Icon />
                Delete {selected.length}
              </Button>
            }
          />
        </>
      ) : null}
    </div>
  )
}
