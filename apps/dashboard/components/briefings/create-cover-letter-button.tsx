"use client"

import { useState } from "react"

import { createCoverLetterAction } from "@/app/(app)/briefings/actions"
import { ActionError } from "@/components/forms/action-error"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { Button } from "@workspace/ui/components/button"
import {
  FileEditorDialog,
  type MarkdownFile,
} from "@workspace/ui/components/file-editor-dialog"

const SAVE_FAILED =
  "Your cover letter could not be saved. Your edit is still here — try again in a moment."

/**
 * Open a blank editor for a manually written cover letter.
 *
 * Saving calls a dedicated action rather than the edit action: an edit must
 * only overwrite an existing object, while this path creates the first object
 * after the server has re-checked the Posting belongs to the current user.
 */
export function CreateCoverLetterButton({
  postingId,
  title,
}: {
  postingId: string
  /** Used only to distinguish this button for assistive technology. */
  title: string
}) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  const [saveState, setSaveState] = useState<ActionState>(IDLE)
  const [session, setSession] = useState(0)

  function openBlankEditor() {
    const visit = session + 1
    setFiles([
      {
        id: `${postingId}#new-${visit}`,
        name: "Cover letter.md",
        content: "",
      },
    ])
    setSession(visit)
    setSaveState(IDLE)
    setOpen(true)
  }

  async function handleSave(edited: MarkdownFile[]) {
    const data = new FormData()
    data.set("postingId", postingId)
    data.set("markdown", edited[0]?.content ?? "")

    try {
      setSaveState(await createCoverLetterAction(IDLE, data))
    } catch (error) {
      console.error("cover-letters: could not create the letter", error)
      setSaveState({ status: "error", message: SAVE_FAILED })
    }
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      openBlankEditor()
      return
    }

    setSaveState(IDLE)
    setOpen(false)
  }

  return (
    <FileEditorDialog
      files={files}
      onFilesChange={setFiles}
      open={open}
      onOpenChange={handleOpenChange}
      title="Create cover letter"
      onSave={handleSave}
      trigger={
        <Button
          variant="outline"
          size="sm"
          aria-label={`Create a cover letter for ${title}`}
        >
          Create cover letter
        </Button>
      }
      footer={
        saveState.status === "success" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {saveState.message}
          </p>
        ) : (
          <ActionError state={saveState} />
        )
      }
    />
  )
}
