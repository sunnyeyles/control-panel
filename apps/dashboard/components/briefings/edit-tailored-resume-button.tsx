"use client"

import dynamic from "next/dynamic"
import { useRef, useState } from "react"

import { saveTailoredResumeAction } from "@/app/(app)/briefings/actions"
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

const LOAD_FAILED =
  "The tailored resume could not be loaded. Try again in a moment."
const LOAD_REFUSED =
  "Your session has expired. Reload the page and sign in again."
const LOAD_GONE =
  "That tailored resume could not be found. Refresh the page and try again."
const SAVE_FAILED =
  "Your changes could not be saved. Your edit is still here — try again in a moment."

/**
 * Open one Posting's tailored resume in the editor.
 *
 * Point for point `edit-cover-letter-button.tsx`, and the two orderings it
 * documents at length are load-bearing here for the same reasons rather than by
 * imitation:
 *
 * - **The body is fetched before the dialog opens.** `FileEditorDialog` loads a
 *   file from an effect keyed on the active file's **id**, with content
 *   deliberately absent from the dependencies, so filling in the body of a file
 *   the editor is already showing changes nothing on screen. Opening only once
 *   the bytes are in hand means the editor always mounts over a complete file.
 * - **The dialog is mounted only while open**, so a bare `postingId` serves as
 *   the file id: every open builds a new editor over freshly fetched bytes,
 *   and there is no surviving editor holding the previous visit's text.
 * - **Focus is returned to the trigger by hand** on close, because that
 *   unmount is what stops Radix doing it — see {@link returnFocusTo}.
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
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // Two states rather than one, because they are read in two places that are
  // never both on screen: a load that fails means no dialog, so its message
  // belongs beside the trigger, while a save happens with the dialog open and
  // belongs in its footer.
  const [loadState, setLoadState] = useState<ActionState>(IDLE)
  const [saveState, setSaveState] = useState<ActionState>(IDLE)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function openWithResume() {
    setLoading(true)
    setLoadState(IDLE)
    setSaveState(IDLE)

    try {
      const response = await fetch(`/api/tailored-resumes/${postingId}`)

      if (!response.ok) {
        // The route conflates "no such resume" with "not yours" deliberately —
        // telling them apart would confirm another user's Posting exists — so
        // there are only three cases to tell apart here.
        setLoadState({
          status: "error",
          message:
            response.status === 401
              ? LOAD_REFUSED
              : response.status === 404
                ? LOAD_GONE
                : LOAD_FAILED,
        })
        return
      }

      setFiles([
        {
          id: postingId,
          name: filename,
          content: await response.text(),
        },
      ])
      setOpen(true)
    } catch (error) {
      // A dropped connection or an aborted request. Nothing the user can act on
      // beyond retrying, but it must not fail silently into an empty editor.
      console.error("tailored-resumes: could not load the resume", error)
      setLoadState({ status: "error", message: LOAD_FAILED })
    } finally {
      setLoading(false)
    }
  }

  /**
   * Write the edited resume back.
   *
   * Called imperatively rather than through `useActionState` and a `<form>`,
   * because the Save button that triggers it lives inside the shared dialog
   * rather than in this component's own markup. `refresh()` still runs — it is
   * inside the action, which has Next's request store either way.
   */
  async function handleSave(edited: MarkdownFile[]) {
    const data = new FormData()
    data.set("postingId", postingId)
    data.set("markdown", edited[0]?.content ?? "")

    try {
      setSaveState(await saveTailoredResumeAction(IDLE, data))
    } catch (error) {
      // The action itself never throws for an expected failure — it returns an
      // error state. This is the transport failing. Caught here because
      // `FileEditorDialog` releases its button in a `finally` rather than a
      // `catch`, so an escaping rejection would leave the spinner cleared, no
      // message rendered, and the user believing the resume was saved.
      console.error("tailored-resumes: could not save the resume", error)
      setSaveState({ status: "error", message: SAVE_FAILED })
    }
  }

  /** Only ever called with `false` — the trigger is outside the dialog now. */
  function handleOpenChange(next: boolean) {
    if (next) return

    // Clear the last save's message, or reopening shows a confirmation for an
    // edit made a visit ago.
    setSaveState(IDLE)
    setOpen(false)
    returnFocusTo(triggerRef.current)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Outside the lazy boundary, and what focus returns to on close. */}
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => void openWithResume()}
        aria-label={`Edit the tailored resume for ${displayName}`}
      >
        {loading ? "Opening…" : "Edit resume"}
      </Button>

      {open ? (
        <FileEditorDialog
          files={files}
          onFilesChange={setFiles}
          open={open}
          onOpenChange={handleOpenChange}
          title="Tailored resume"
          onSave={handleSave}
          footer={
            saveState.status === "success" ? (
              // A save leaves the text exactly as it was, so there is no
              // visible change to serve as its own confirmation.
              <p className="text-sm text-muted-foreground" role="status">
                {saveState.message}
              </p>
            ) : (
              <ActionError state={saveState} />
            )
          }
        />
      ) : null}

      {/*
        Outside the dialog, because a load that fails is a dialog that never
        opened — a message in its footer would be behind an overlay that is not
        there.
      */}
      <ActionError state={loadState} />
    </div>
  )
}
