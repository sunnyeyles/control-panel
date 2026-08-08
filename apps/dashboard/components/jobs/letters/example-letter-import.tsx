"use client"

import { useActionState, useState } from "react"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import { importExampleLetterAction } from "@/app/(app)/jobs/letters/actions"
import { IDLE } from "@/lib/actions/action-state"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

/**
 * One document this form can read an example letter out of.
 *
 * Plain strings only. The section above resolves these on the server — the
 * document type is already a label, and `uploadedAt` is a `Date` and does not
 * cross at all.
 */
export interface ImportableDocument {
  /** `{resumeId}{extension}` — what the action reads back to find the object. */
  file: string
  /** What the user called it, or the id when the metadata could not be read. */
  name: string
  /** The Document Type, so a CV is not mistaken for a letter. */
  type: string
}

/**
 * Fill the example letter from something already uploaded.
 *
 * **A separate `<form>`, so it posts on its own** — importing is not part of
 * saving, and putting a second submit button inside the instructions form would
 * make it ambiguous which one the Enter key means.
 *
 * The import writes the extracted text straight into the row; the field above
 * then re-renders with it, ready to be edited and saved like anything typed
 * there.
 */
export function ExampleLetterImport({
  documents,
}: {
  documents: readonly ImportableDocument[]
}) {
  const [state, formAction, pending] = useActionState(
    importExampleLetterAction,
    IDLE
  )
  const [file, setFile] = useState(documents[0]?.file ?? "")

  // An honest sentence rather than an empty picker with a button beside it —
  // the second looks broken, and it is the same shape as having uploaded
  // nothing at all.
  if (documents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        You can also fill the example from a document you have uploaded. None of
        yours can be read as text yet — upload a .md, .txt, PDF or Word file
        under Documents and it will be offered here.
      </p>
    )
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="example-letter-document">
          Or fill it from a document you have uploaded
        </Label>
        {/*
          Both sentences are requirements rather than reassurance. The first
          because the import overwrites without asking; the second because the
          example is a copy and not a link — a user who thinks otherwise will
          re-upload the document, change nothing, and never find out.
        */}
        <p className="text-sm text-muted-foreground">
          Replaces what is in the example box above. It is a one-time copy —
          re-uploading the document later does not update the example, so import
          it again if it changes.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={file} onValueChange={setFile} disabled={pending}>
          <SelectTrigger
            id="example-letter-document"
            className="w-full flex-1 sm:w-auto"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {documents.map((document) => (
              <SelectItem key={document.file} value={document.file}>
                {document.name} · {document.type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <SubmitButton
          pending={pending}
          label="Fill from document"
          pendingLabel="Reading…"
          variant="secondary"
        />
      </div>

      {/*
        A Radix Select renders a button, not a <select>, so its value never
        reaches FormData on its own. This hidden input is what actually submits
        the document — omitting it is the quiet way this posts no document at
        all.
      */}
      <input type="hidden" name="file" value={file} />

      <ActionAlert state={state} />
    </form>
  )
}
