"use client"

import { saveCoverLetterAction } from "@/app/(app)/jobs/actions"
import {
  EditPostingDocumentButton,
  type EditPostingDocumentLabels,
} from "@/components/jobs/postings/edit-posting-document-button"

const LABELS: EditPostingDocumentLabels = {
  title: "Cover letter",
  trigger: "Edit letter",
  ariaLabel: (displayName) => `Edit the cover letter for ${displayName}`,
  loadFailed: "The cover letter could not be loaded. Try again in a moment.",
  loadRefused: "Your session has expired. Reload the page and sign in again.",
  loadGone:
    "That cover letter could not be found. Refresh the page and try again.",
  saveFailed:
    "Your changes could not be saved. Your edit is still here — try again in a moment.",
  logScope: "cover-letters",
}

/**
 * Open one Posting's drafted Cover Letter in the editor.
 *
 * Thin wrapper over {@link EditPostingDocumentButton}: the client protocol is
 * shared with the tailored resume; the strings and endpoints are not
 * (CONTEXT).
 */
export function EditCoverLetterButton({
  postingId,
  displayName,
  filename,
}: {
  postingId: string
  /** Only for the accessible label, so several buttons on a page differ. */
  displayName: string
  /** The name the file carries in the editor, and the stem of the PDF. */
  filename: string
}) {
  return (
    <EditPostingDocumentButton
      postingId={postingId}
      displayName={displayName}
      filename={filename}
      fetchUrl={`/api/cover-letters/${postingId}`}
      saveAction={saveCoverLetterAction}
      labels={LABELS}
    />
  )
}
