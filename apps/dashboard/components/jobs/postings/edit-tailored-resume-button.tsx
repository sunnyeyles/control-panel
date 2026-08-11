"use client"

import { saveTailoredResumeAction } from "@/app/(app)/jobs/actions"
import {
  EditPostingDocumentButton,
  type EditPostingDocumentLabels,
} from "@/components/jobs/postings/edit-posting-document-button"

const LABELS: EditPostingDocumentLabels = {
  title: "Tailored resume",
  trigger: "Edit resume",
  ariaLabel: (displayName) => `Edit the tailored resume for ${displayName}`,
  loadFailed: "The tailored resume could not be loaded. Try again in a moment.",
  loadRefused: "Your session has expired. Reload the page and sign in again.",
  loadGone:
    "That tailored resume could not be found. Refresh the page and try again.",
  saveFailed:
    "Your changes could not be saved. Your edit is still here — try again in a moment.",
  logScope: "tailored-resumes",
}

/**
 * Open one Posting's tailored resume in the editor.
 *
 * Thin wrapper over {@link EditPostingDocumentButton}: the client protocol is
 * shared with the cover letter; the strings and endpoints are not (CONTEXT).
 *
 * ⚠️ **The dialog's own "Download PDF" is the PDF export for the edit path, and
 * it is why this component needs no PDF code.** `FileEditorDialog` renders that
 * button unconditionally and runs `exportMarkdownToPdf` over whatever is in the
 * editor. The separate {@link TailoredResumePdfButton} exists for the case this
 * one cannot serve: wanting the PDF without opening an editor first.
 */
export function EditTailoredResumeButton({
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
      fetchUrl={`/api/tailored-resumes/${postingId}`}
      saveAction={saveTailoredResumeAction}
      labels={LABELS}
    />
  )
}
