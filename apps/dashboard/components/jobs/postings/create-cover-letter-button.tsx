"use client"

import dynamic from "next/dynamic"
import { useRef, useState } from "react"

import { createCoverLetterAction } from "@/app/(app)/jobs/actions"
import { ActionError } from "@/components/forms/action-error"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { returnFocusTo } from "@/lib/focus/return-focus"
import { Button } from "@workspace/ui/components/button"
import type { MarkdownFile } from "@workspace/ui/components/file-editor-dialog"

/** Deferred for the reason `edit-cover-letter-button.tsx` sets out: TipTap. */
const FileEditorDialog = dynamic(() =>
  import("@workspace/ui/components/file-editor-dialog").then(
    (module) => module.FileEditorDialog
  )
)

const SAVE_FAILED =
  "Your cover letter could not be saved. Your edit is still here — try again in a moment."

/**
 * Open a blank editor for a manually written cover letter.
 *
 * Saving calls a dedicated action rather than the edit action: an edit must
 * only overwrite an existing object, while this path creates the first object
 * after the server has re-checked the Posting belongs to the current user.
 *
 * ⚠️ **This button waits on the editor chunk explicitly; its two siblings do
 * not need to.** They fetch a stored document first, and that request already
 * hides the chunk download behind "Opening…". Nothing is fetched here — the
 * letter starts empty — so without the wait, deferring TipTap turns an instant
 * open into a button that looks dead. The `import()` is the same specifier
 * {@link FileEditorDialog} is built from, so it resolves from the module
 * registry rather than downloading twice.
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
  const [loading, setLoading] = useState(false)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  const [saveState, setSaveState] = useState<ActionState>(IDLE)
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function openBlankEditor() {
    setLoading(true)

    try {
      await import("@workspace/ui/components/file-editor-dialog")

      setFiles([{ id: postingId, name: "Cover letter.md", content: "" }])
      setSaveState(IDLE)
      setOpen(true)
    } catch (error) {
      // A chunk that will not load is a network fault, not something the user
      // did. Leaving the button released lets them try again.
      console.error("cover-letters: could not load the editor", error)
    } finally {
      setLoading(false)
    }
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

  /** Only ever called with `false` — the trigger is outside the dialog now. */
  function handleOpenChange(next: boolean) {
    if (next) return

    setSaveState(IDLE)
    setOpen(false)
    returnFocusTo(triggerRef.current)
  }

  return (
    <>
      {/* Outside the lazy boundary, and what focus returns to on close. */}
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => void openBlankEditor()}
        aria-label={`Create a cover letter for ${title}`}
      >
        {loading ? "Opening…" : "Create cover letter"}
      </Button>

      {open ? (
        <FileEditorDialog
          files={files}
          onFilesChange={setFiles}
          open={open}
          onOpenChange={handleOpenChange}
          title="Create cover letter"
          onSave={handleSave}
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
      ) : null}
    </>
  )
}
