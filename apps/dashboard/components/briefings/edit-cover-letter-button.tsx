"use client"

import dynamic from "next/dynamic"
import { useRef, useState } from "react"

import { saveCoverLetterAction } from "@/app/(app)/briefings/actions"
import { ActionError } from "@/components/forms/action-error"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { returnFocusTo } from "@/lib/focus/return-focus"
import { Button } from "@workspace/ui/components/button"
import type { MarkdownFile } from "@workspace/ui/components/file-editor-dialog"

/**
 * ⚠️ **Deferred so TipTap is not in this page's first load.** The editor drags
 * in ProseMirror and the markdown pipeline behind it, and `/briefings` renders
 * one of these buttons per Posting while most visits open none of them. A
 * static import would ship all of that to every visitor to serve the few who
 * click. The type is imported separately above because a `type` import erases
 * at compile time and so cannot pull the chunk back in.
 */
const FileEditorDialog = dynamic(() =>
  import("@workspace/ui/components/file-editor-dialog").then(
    (module) => module.FileEditorDialog
  )
)

const LOAD_FAILED =
  "The cover letter could not be loaded. Try again in a moment."
const LOAD_REFUSED =
  "Your session has expired. Reload the page and sign in again."
const LOAD_GONE =
  "That cover letter could not be found. Refresh the page and try again."
const SAVE_FAILED =
  "Your changes could not be saved. Your edit is still here — try again in a moment."

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
 * **The dialog is mounted only while it is open, and that is what makes a plain
 * `postingId` a sufficient file id.** The id used to carry a per-visit suffix:
 * with the dialog mounted permanently, a second open re-fetched the letter but
 * handed the editor the same id it already held, so the effect declined to
 * re-run and the user was shown the previous visit's text. Unmounting on close
 * settles that at the source — every open builds a new editor over freshly
 * fetched bytes, so there is no stale content for a changing id to defeat.
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
  // Two states rather than one, because they are read in two places that are
  // never both on screen: a load that fails means no dialog, so its message
  // belongs beside the trigger, while a save happens with the dialog open and
  // belongs in its footer. Sharing one would put the same `role="status"` text
  // in the document twice.
  const [loadState, setLoadState] = useState<ActionState>(IDLE)
  const [saveState, setSaveState] = useState<ActionState>(IDLE)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  // The dialog no longer renders the trigger, so Radix cannot restore focus to
  // it on close — see {@link handleOpenChange}.
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function openWithLetter() {
    setLoading(true)
    setLoadState(IDLE)
    setSaveState(IDLE)

    try {
      const response = await fetch(`/api/cover-letters/${postingId}`)

      if (!response.ok) {
        // The route conflates "no such letter" with "not yours" deliberately —
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
      console.error("cover-letters: could not load the letter", error)
      setLoadState({ status: "error", message: LOAD_FAILED })
    } finally {
      setLoading(false)
    }
  }

  /**
   * Write the edited letter back.
   *
   * Called imperatively rather than through `useActionState` and a `<form>`,
   * because the Save button that triggers it lives inside the shared dialog
   * rather than in this component's own markup. `refresh()` still runs — it is
   * inside the action, which has Next's request store either way.
   *
   * The letter is `files[0]` and there is only ever one: this dialog is opened
   * for a single Posting.
   */
  async function handleSave(edited: MarkdownFile[]) {
    const data = new FormData()
    data.set("postingId", postingId)
    data.set("markdown", edited[0]?.content ?? "")

    try {
      setSaveState(await saveCoverLetterAction(IDLE, data))
    } catch (error) {
      // The action itself never throws for an expected failure — it returns an
      // error state. This is the transport failing: a dropped connection, or
      // Next unable to route the action at all. Caught here because
      // `FileEditorDialog` releases its button in a `finally` rather than a
      // `catch`, so an escaping rejection would leave the spinner cleared, no
      // message rendered, and the user believing the letter was saved.
      console.error("cover-letters: could not save the letter", error)
      setSaveState({ status: "error", message: SAVE_FAILED })
    }
  }

  /**
   * Close the dialog. **Only ever called with `false`** — the trigger lives
   * outside the dialog now, so nothing inside it can ask to open.
   *
   * Closing unmounts the dialog, which is why focus has to be put back by
   * hand — see {@link returnFocusTo}.
   */
  function handleOpenChange(next: boolean) {
    if (next) return

    // Clear the last save's message, or reopening shows a confirmation for
    // an edit made a visit ago.
    setSaveState(IDLE)
    setOpen(false)
    returnFocusTo(triggerRef.current)
  }

  return (
    <div className="flex flex-col gap-2">
      {/*
        Outside the lazy boundary, and deliberately not `disabled` while the
        dialog is open: this button is what focus returns to on close, and a
        disabled control cannot hold focus. The open dialog is modal, so there
        is nothing to guard against by disabling it.
      */}
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => void openWithLetter()}
        aria-label={`Edit the cover letter for ${displayName}`}
      >
        {loading ? "Opening…" : "Edit letter"}
      </Button>

      {open ? (
        <FileEditorDialog
          files={files}
          onFilesChange={setFiles}
          open={open}
          onOpenChange={handleOpenChange}
          title="Cover letter"
          onSave={handleSave}
          footer={
            saveState.status === "success" ? (
              // A save leaves the text exactly as it was, so there is no
              // visible change to serve as its own confirmation — which is the
              // case `ActionError` explicitly does not cover, hence a line of
              // its own.
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
        there. `ActionError` rather than `ActionAlert` for the reason its own
        docblock gives: this sits next to a control with no room for a box.
      */}
      <ActionError state={loadState} />
    </div>
  )
}
