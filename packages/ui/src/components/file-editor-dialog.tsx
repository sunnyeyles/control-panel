"use client"

import * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"

import { cn } from "@workspace/ui/lib/utils"
import {
  createMarkdownSerializer,
  markdownToHtml,
} from "@workspace/ui/lib/markdown"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { EditorToolbar } from "@workspace/ui/components/editor-toolbar"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import { DownloadIcon, FileTextIcon, Loader2Icon, SaveIcon } from "lucide-react"

export interface MarkdownFile {
  id: string
  name: string
  content: string
}

export interface FileEditorDialogProps {
  /** The files to edit. Treated as controlled when `onFilesChange` is given. */
  files: MarkdownFile[]
  /**
   * Receives the full file list every time the active file is serialized back
   * to markdown — on switching files, on download, and on closing the dialog.
   * Omit it and the component keeps its own copy instead.
   */
  onFilesChange?: (files: MarkdownFile[]) => void
  /** Replaces the default "File editor" heading. */
  title?: React.ReactNode
  /**
   * Supplied ⇒ a Save button appears in the footer, left of the PDF export.
   *
   * It receives the file list with the active file already serialized back to
   * markdown, so a caller never has to reach into the editor to find out what
   * the user typed. Awaited, so the button can report the write.
   */
  onSave?: (files: MarkdownFile[]) => void | Promise<void>
  /**
   * Rendered in the footer beneath the active file's name.
   *
   * The slot exists so a caller's own status — a refused save, a confirmation —
   * lands *inside* the open dialog. A message rendered beside the trigger would
   * sit behind the overlay, unreadable until the user closed the thing the
   * message is about.
   */
  footer?: React.ReactNode
  /**
   * ⚠️ **Required: this dialog renders no trigger of its own.**
   *
   * Every caller mounts it only while it is open, so that TipTap — the editor,
   * its ProseMirror core and the markdown pipeline — is fetched on the first
   * open rather than shipped with the page. A dialog that rendered its own
   * trigger could not be mounted lazily, because the trigger is the thing that
   * has to be on screen *before* the chunk is wanted. Opening is therefore the
   * caller's business, and this is the only way in.
   */
  open: boolean
  /** Required for the same reason `open` is — nothing here closes itself. */
  onOpenChange: (open: boolean) => void
  className?: string
}

function FileEditorDialog({
  files,
  onFilesChange,
  title = "File editor",
  onSave,
  footer,
  open,
  onOpenChange,
  className,
}: FileEditorDialogProps) {
  const [internalFiles, setInternalFiles] = useState(files)
  const [activeId, setActiveId] = useState(() => files[0]?.id ?? "")
  const [exporting, setExporting] = useState(false)
  const [saving, setSaving] = useState(false)

  const currentFiles = onFilesChange ? files : internalFiles

  const turndown = useMemo(() => createMarkdownSerializer(), [])

  const activeFile =
    currentFiles.find((file) => file.id === activeId) ?? currentFiles[0]

  // Both switchers are chrome for a choice that does not exist when there is
  // one file — a 208px sidebar listing a single entry, and below `sm` a
  // dropdown with one option. A caller editing one document is the ordinary
  // case, not a degenerate one.
  const showFileList = currentFiles.length > 1

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    // The editor renders on the client only. Without this, TipTap renders
    // during SSR against a DOM that is not there yet and the markup mismatches.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "tiptap-editor focus:outline-none",
        "aria-label": "Markdown editor",
      },
    },
  })

  // The editor holds the live copy of the active file while it is open, so the
  // content effect below must not re-run when `files` changes — that would
  // discard whatever is being typed. It reads the list through a ref for that
  // reason, and this effect keeps the ref current.
  const filesRef = useRef(currentFiles)
  useEffect(() => {
    filesRef.current = currentFiles
  })

  // Load the selected file into the editor. Keyed on the *derived* id, not on
  // `activeId`, so the two cases where the selection stops resolving — a list
  // that arrives after mount, and a parent that removes the file being edited —
  // fall through to the first file and reload here on their own. Keeping
  // `activeId` as nothing more than "what the user last clicked" is what avoids
  // an effect that corrects state and cascades a render.
  //
  // Content is deliberately not a dependency: those changes are the editor's
  // own output coming back around.
  const activeFileId = activeFile?.id
  useEffect(() => {
    if (!editor) return
    const file = filesRef.current.find((f) => f.id === activeFileId)
    editor.commands.setContent(markdownToHtml(file?.content ?? ""))
  }, [editor, activeFileId])

  function updateFiles(next: MarkdownFile[]) {
    if (!onFilesChange) setInternalFiles(next)
    onFilesChange?.(next)
  }

  /**
   * The file list with the active file's editor content serialized back to
   * markdown — the single place the editor's HTML becomes markdown again.
   *
   * Returns the list rather than only pushing it into state because both
   * callers that *do* something with the bytes — the PDF export and
   * {@link FileEditorDialogProps.onSave} — need them in hand, and re-running
   * Turndown to get a second copy is how the two would drift.
   */
  function serializeActiveFile(): { files: MarkdownFile[]; markdown: string } {
    if (!editor || !activeFile) return { files: currentFiles, markdown: "" }

    const markdown = turndown.turndown(editor.getHTML())

    return {
      files: currentFiles.map((file) =>
        file.id === activeFile.id ? { ...file, content: markdown } : file
      ),
      markdown,
    }
  }

  /** Serialize the current editor content back to markdown in state. */
  function saveActiveFile() {
    if (!editor || !activeFile) return
    updateFiles(serializeActiveFile().files)
  }

  function switchFile(id: string) {
    if (!editor || id === activeFileId) return
    saveActiveFile()
    setActiveId(id)
  }

  function handleOpenChange(next: boolean) {
    // Save on close too, or everything typed since the last file switch is
    // lost and `onFilesChange` never hears about it.
    if (!next) saveActiveFile()
    onOpenChange(next)
  }

  async function downloadPdf() {
    if (!editor || !activeFile) return

    const { files: next, markdown } = serializeActiveFile()
    updateFiles(next)
    setExporting(true)

    try {
      // jsPDF is fetched on the click, not with the dialog. Callers already
      // mount this component lazily so TipTap is not in the page chunk; a
      // static import here would have put a PDF writer in the *editor* chunk
      // for everyone who opens it only to save. Same shape as
      // `apps/dashboard/components/briefings/tailored-resume-pdf-button.tsx`.
      const { exportMarkdownToPdf } =
        await import("@workspace/ui/lib/pdf-export")
      const pdfName = activeFile.name.replace(/\.md$/i, ".pdf")
      exportMarkdownToPdf(markdown, pdfName)
    } catch (error) {
      console.error("PDF export failed:", error)
    } finally {
      setExporting(false)
    }
  }

  async function handleSave() {
    if (!editor || !activeFile || !onSave) return

    const { files: next } = serializeActiveFile()
    updateFiles(next)
    setSaving(true)

    try {
      await onSave(next)
    } finally {
      // The caller reports the outcome through `footer`; all this owns is
      // whether the button is still spinning. A `finally` rather than a
      // `catch`, so a caller that throws still releases the button and the
      // rejection still reaches the console rather than being swallowed here.
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-slot="file-editor-dialog"
        className={cn(
          "flex h-[85vh] flex-col gap-0 p-0 sm:max-w-4xl",
          className
        )}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Edit markdown files with rich text formatting and download them as
            PDF.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* File sidebar */}
          {showFileList && (
            <nav
              aria-label="Files"
              className="hidden w-52 shrink-0 border-r border-border bg-muted/40 sm:block"
            >
              <ScrollArea className="h-full">
                <ul className="flex flex-col gap-0.5 p-2">
                  {currentFiles.map((file) => (
                    <li key={file.id}>
                      <button
                        type="button"
                        onClick={() => switchFile(file.id)}
                        aria-current={
                          file.id === activeFile?.id ? "true" : undefined
                        }
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                          file.id === activeFile?.id
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        )}
                      >
                        <FileTextIcon className="size-4 shrink-0" />
                        <span className="truncate">{file.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </nav>
          )}

          {/* Editor area */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Mobile file switcher */}
            {showFileList && (
              <div className="border-b border-border p-2 sm:hidden">
                <label htmlFor="file-editor-file-select" className="sr-only">
                  Select file
                </label>
                <select
                  id="file-editor-file-select"
                  value={activeFile?.id ?? ""}
                  onChange={(event) => switchFile(event.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                >
                  {currentFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {editor && <EditorToolbar editor={editor} />}

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 py-5">
                {activeFile ? (
                  <EditorContent editor={editor} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No files to edit.
                  </p>
                )}
              </div>
            </ScrollArea>

            <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="truncate text-sm text-muted-foreground">
                  {activeFile?.name ?? "No file selected"}
                </p>
                {footer}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {onSave && (
                  <Button
                    variant="outline"
                    onClick={handleSave}
                    disabled={saving || exporting || !editor || !activeFile}
                  >
                    {saving ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <SaveIcon className="size-4" />
                    )}
                    {saving ? "Saving…" : "Save"}
                  </Button>
                )}

                <Button
                  onClick={downloadPdf}
                  disabled={exporting || saving || !editor || !activeFile}
                >
                  {exporting ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <DownloadIcon className="size-4" />
                  )}
                  {exporting ? "Preparing PDF…" : "Download PDF"}
                </Button>
              </div>
            </footer>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { FileEditorDialog }
