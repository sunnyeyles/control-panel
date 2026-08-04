"use client"

import * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { marked } from "marked"
import TurndownService from "turndown"

import { cn } from "@workspace/ui/lib/utils"
import { exportMarkdownToPdf } from "@workspace/ui/lib/pdf-export"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import { EditorToolbar } from "@workspace/ui/components/editor-toolbar"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import { DownloadIcon, FileTextIcon, Loader2Icon } from "lucide-react"

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
  /** Replaces the default "Open file editor" button. */
  trigger?: React.ReactNode
  /** Replaces the default "File editor" heading. */
  title?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false })
}

function FileEditorDialog({
  files,
  onFilesChange,
  trigger,
  title = "File editor",
  open,
  onOpenChange,
  className,
}: FileEditorDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [internalFiles, setInternalFiles] = useState(files)
  const [activeId, setActiveId] = useState(() => files[0]?.id ?? "")
  const [exporting, setExporting] = useState(false)

  const isOpen = open ?? internalOpen
  const currentFiles = onFilesChange ? files : internalFiles

  const turndown = useMemo(
    () =>
      new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }),
    []
  )

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

  /** Serialize the current editor content back to markdown in state. */
  function saveActiveFile() {
    if (!editor || !activeFile) return
    const markdown = turndown.turndown(editor.getHTML())
    updateFiles(
      currentFiles.map((file) =>
        file.id === activeFile.id ? { ...file, content: markdown } : file
      )
    )
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
    if (open === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  function downloadPdf() {
    if (!editor || !activeFile) return
    saveActiveFile()
    setExporting(true)
    try {
      const pdfName = activeFile.name.replace(/\.md$/i, ".pdf")
      const markdown = turndown.turndown(editor.getHTML())
      exportMarkdownToPdf(markdown, pdfName)
    } catch (error) {
      console.error("PDF export failed:", error)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="lg">
            <FileTextIcon className="size-4" />
            Open file editor
          </Button>
        )}
      </DialogTrigger>
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
              <p className="truncate text-sm text-muted-foreground">
                {activeFile?.name ?? "No file selected"}
              </p>
              <Button
                onClick={downloadPdf}
                disabled={exporting || !editor || !activeFile}
              >
                {exporting ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <DownloadIcon className="size-4" />
                )}
                {exporting ? "Preparing PDF…" : "Download PDF"}
              </Button>
            </footer>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { FileEditorDialog }
