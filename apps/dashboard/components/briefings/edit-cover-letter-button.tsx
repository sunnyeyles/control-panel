"use client"

import { useState } from "react"

import { ActionError } from "@/components/forms/action-error"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { Button } from "@workspace/ui/components/button"
import {
  FileEditorDialog,
  type MarkdownFile,
} from "@workspace/ui/components/file-editor-dialog"

const LOAD_FAILED =
  "The cover letter could not be loaded. Try again in a moment."
const LOAD_REFUSED =
  "Your session has expired. Reload the page and sign in again."
const LOAD_GONE =
  "That cover letter could not be found. Refresh the page and try again."

/**
 * Open one Posting's drafted Cover Letter in the editor.
 *
 * **The letter body is fetched when the button is clicked, never rendered into
 * the page.** The summary this button is built from carries metadata only —
 * title, company, when it was drafted — and deliberately no markdown:
 * server-rendering every body into every card would pull the user's whole shelf
 * out of object storage on each page load, on top of the `head()`-per-letter the
 * listing already costs. The download route that serves one letter is reused
 * rather than restated, which also keeps the ownership rule in one place: the
 * caller supplies the last key segment and the session supplies the user, so a
 * request naming another user's letter cannot be spelled.
 *
 * ⚠️ **The fetch finishes *before* the dialog opens, and that ordering is
 * load-bearing rather than cosmetic.** `FileEditorDialog` loads a file into the
 * editor from an effect keyed on the active file's **id**, with content
 * deliberately absent from the dependencies — content changes are normally the
 * editor's own output coming back around, and re-running on them would fight the
 * user's typing. So filling in the body of a file the editor is already showing
 * changes nothing on screen: same id, no reload. Opening only once the bytes are
 * in hand means the editor always mounts over a complete file.
 *
 * **`session` keys the dialog for the same reason**, one step later. A second
 * open re-fetches, and the re-fetched letter has the same id as the first — so
 * without a remount the effect would again decline to re-run and the editor
 * would show the previous visit's text rather than what is stored. Incrementing
 * the key per open makes each visit a fresh editing session over freshly
 * fetched bytes, which is exactly what it is.
 *
 * Refetching every time rather than caching follows from the same idea: the
 * stored letter is the thing being edited, and a cached copy would show the user
 * their own unsaved edit after a save had failed.
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
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<ActionState>(IDLE)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  const [session, setSession] = useState(0)

  async function openWithLetter() {
    setLoading(true)
    setState(IDLE)

    try {
      const response = await fetch(`/api/cover-letters/${postingId}`)

      if (!response.ok) {
        // The route conflates "no such letter" with "not yours" deliberately —
        // telling them apart would confirm another user's Posting exists — so
        // there are only three cases to tell apart here.
        setState({
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
        { id: postingId, name: filename, content: await response.text() },
      ])
      setSession((previous) => previous + 1)
      setOpen(true)
    } catch (error) {
      // A dropped connection or an aborted request. Nothing the user can act on
      // beyond retrying, but it must not fail silently into an empty editor.
      console.error("cover-letters: could not load the letter", error)
      setState({ status: "error", message: LOAD_FAILED })
    } finally {
      setLoading(false)
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setOpen(false)
      return
    }

    // The trigger asks to open; the fetch decides when. Deliberately not
    // awaited — this is a DOM event handler, and the button's pending state is
    // what reports the wait.
    void openWithLetter()
  }

  return (
    <div className="flex flex-col gap-2">
      <FileEditorDialog
        key={session}
        files={files}
        onFilesChange={setFiles}
        open={open}
        onOpenChange={handleOpenChange}
        title="Cover letter"
        trigger={
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            aria-label={`Edit the cover letter for ${displayName}`}
          >
            {loading ? "Opening…" : "Edit letter"}
          </Button>
        }
      />

      {/*
        Outside the dialog, because a load that fails is a dialog that never
        opened — a message in its footer would be behind an overlay that is not
        there. `ActionError` rather than `ActionAlert` for the reason its own
        docblock gives: this sits next to a control with no room for a box.
      */}
      <ActionError state={state} />
    </div>
  )
}
