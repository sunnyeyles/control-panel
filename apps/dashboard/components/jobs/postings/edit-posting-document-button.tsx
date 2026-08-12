"use client"

import dynamic from "next/dynamic"
import { useRef, useState } from "react"

import { ActionError } from "@/components/forms/action-error"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { returnFocusTo } from "@/lib/focus/return-focus"
import { Button } from "@workspace/ui/components/button"
import type { MarkdownFile } from "@workspace/ui/components/file-editor-dialog"

/**
 * ⚠️ **Deferred so TipTap is not in this page's first load.** The editor drags
 * in ProseMirror and the markdown pipeline behind it, and `/jobs` renders one
 * of these buttons per Posting while most visits open none of them. A static
 * import would ship all of that to every visitor to serve the few who click.
 * The type is imported separately above because a `type` import erases at
 * compile time and so cannot pull the chunk back in.
 */
const FileEditorDialog = dynamic(() =>
  import("@workspace/ui/components/file-editor-dialog").then(
    (module) => module.FileEditorDialog
  )
)

/**
 * Kind-specific strings and endpoints the shared editor protocol needs.
 *
 * User-facing copy stays per feature (CONTEXT): cover letters and tailored
 * resumes are not one product surface even when the client protocol is.
 */
export interface EditPostingDocumentLabels {
  /** Dialog title. */
  title: string
  /** Idle button label. */
  trigger: string
  /** Accessible name: receives the Posting's display name. */
  ariaLabel: (displayName: string) => string
  loadFailed: string
  loadRefused: string
  loadGone: string
  saveFailed: string
  /** Console prefix when fetch/save transport fails. */
  logScope: string
}

type SaveAction = (
  state: ActionState,
  formData: FormData
) => Promise<ActionState>

/**
 * Open one Posting Document in the shared markdown editor.
 *
 * **The body is fetched on click, never rendered into the page** — otherwise
 * every page load pulls the user's whole shelf out of object storage.
 *
 * ⚠️ **The fetch finishes *before* the dialog opens.** `FileEditorDialog` loads
 * a file from an effect keyed on the file's **id**, with content deliberately
 * out of the dependencies (content changes are usually the editor's own output
 * coming back, and re-running would fight the user's typing) — so filling in
 * the body of a file it already shows changes nothing on screen.
 *
 * The dialog is mounted only while open, so a plain `postingId` suffices as a
 * file id, and refetching every time is deliberate: a cached copy would show
 * the user their own unsaved edit after a save had failed.
 */
export function EditPostingDocumentButton({
  postingId,
  displayName,
  filename,
  fetchUrl,
  saveAction,
  labels,
}: {
  postingId: string
  /** Only for the accessible label, so several buttons on a page differ. */
  displayName: string
  /** The name the file carries in the editor, and the stem of the PDF. */
  filename: string
  fetchUrl: string
  saveAction: SaveAction
  labels: EditPostingDocumentLabels
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

  async function openWithDocument() {
    setLoading(true)
    setLoadState(IDLE)
    setSaveState(IDLE)

    try {
      const response = await fetch(fetchUrl)

      if (!response.ok) {
        // The route conflates "no such document" with "not yours" deliberately —
        // telling them apart would confirm another user's Posting exists — so
        // there are only three cases to tell apart here.
        setLoadState({
          status: "error",
          message:
            response.status === 401
              ? labels.loadRefused
              : response.status === 404
                ? labels.loadGone
                : labels.loadFailed,
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
      console.error(`${labels.logScope}: could not load the document`, error)
      setLoadState({ status: "error", message: labels.loadFailed })
    } finally {
      setLoading(false)
    }
  }

  /**
   * Write the edited document back.
   *
   * Called imperatively rather than through `useActionState` and a `<form>`,
   * because the Save button that triggers it lives inside the shared dialog
   * rather than in this component's own markup. `refresh()` still runs — it is
   * inside the action, which has Next's request store either way.
   *
   * The document is `files[0]` and there is only ever one: this dialog is
   * opened for a single Posting.
   */
  async function handleSave(edited: MarkdownFile[]) {
    const data = new FormData()
    data.set("postingId", postingId)
    data.set("markdown", edited[0]?.content ?? "")

    try {
      setSaveState(await saveAction(IDLE, data))
    } catch (error) {
      // The action itself never throws for an expected failure — it returns an
      // error state. This is the transport failing: a dropped connection, or
      // Next unable to route the action at all. Caught here because
      // `FileEditorDialog` releases its button in a `finally` rather than a
      // `catch`, so an escaping rejection would leave the spinner cleared, no
      // message rendered, and the user believing the document was saved.
      console.error(`${labels.logScope}: could not save the document`, error)
      setSaveState({ status: "error", message: labels.saveFailed })
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
        onClick={() => void openWithDocument()}
        aria-label={labels.ariaLabel(displayName)}
      >
        {loading ? "Opening…" : labels.trigger}
      </Button>

      {open ? (
        <FileEditorDialog
          files={files}
          onFilesChange={setFiles}
          open={open}
          onOpenChange={handleOpenChange}
          title={labels.title}
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
