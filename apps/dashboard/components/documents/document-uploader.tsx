"use client"

import { useActionState, useState } from "react"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import { uploadDocumentAction } from "@/app/(app)/documents/actions"
import { IDLE } from "@/lib/actions/action-state"
import { DOCUMENT_TYPE_LABELS } from "@/lib/documents/document-type-labels"
import { MAX_DOCUMENT_BYTES } from "@/lib/documents/upload-validation"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

const MAX_MB = (MAX_DOCUMENT_BYTES / (1024 * 1024)).toFixed(0)

/**
 * Guess what a document is from what it is called.
 *
 * What makes the type field a confirmation rather than a chore: `cv.pdf` or
 * `alice-resume.pdf` arrives with the right answer already selected.
 *
 * ⚠️ Order matters and trades off. `cover|letter` runs first so "cover letter
 * (from my resume pack).pdf" reads as a cover letter — which also makes "letter
 * of reference.pdf" one. Accepted rather than solved: the guess sits beside a
 * visible control for changing it, and reordering only moves which case is wrong.
 */
function inferDocumentType(filename: string): string {
  const name = filename.toLowerCase()

  if (/cover|letter/.test(name)) return "cover-letter"
  if (/portfolio/.test(name)) return "portfolio"
  if (/reference|referee|recommendation/.test(name)) return "reference"
  // `certificat` is the stem deliberately, so one rule catches both
  // "certificate" and "certification".
  if (/certificat|credential|diploma/.test(name)) return "certification"

  return "resume"
}

export function DocumentUploader({
  acceptedExtensions,
}: {
  /**
   * Passed down from the server page rather than imported, for the same reason
   * the type list above is restated: `acceptedResumeExtensions()` lives in the
   * package that carries the AWS SDK.
   */
  acceptedExtensions: string[]
}) {
  const [state, formAction, pending] = useActionState(
    uploadDocumentAction,
    IDLE
  )

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      {/*
        Keyed on the last successful upload's id, so a success remounts the
        fields. That is the form reset, and it means **no effect here at all** —
        resetting from `useEffect` is what `react-hooks/set-state-in-effect`
        warns about.

        ⚠️ **Read the reset key on every non-idle state, not only on a success.**
        An error carries the previous key forward so this holds still; keying on
        `status === "success"` discards the file the user picked at the moment
        they are told to try again.
      */}
      <UploadFields
        key={state.status === "idle" ? "new" : (state.resetKey ?? "new")}
        acceptedExtensions={acceptedExtensions}
        pending={pending}
      />

      <ActionAlert state={state} />
    </form>
  )
}

function UploadFields({
  acceptedExtensions,
  pending,
}: {
  acceptedExtensions: string[]
  pending: boolean
}) {
  const [documentType, setDocumentType] = useState("resume")
  const [tooLarge, setTooLarge] = useState<string>()
  const [chosen, setChosen] = useState(false)

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      setChosen(false)
      setTooLarge(undefined)
      return
    }

    setChosen(true)
    setDocumentType(inferDocumentType(file.name))

    // For the user's benefit only — it saves waiting out an upload in order to
    // be told no. The server's check on the bytes it actually received is the
    // authoritative one and does not trust this at all.
    setTooLarge(
      file.size > MAX_DOCUMENT_BYTES
        ? `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${MAX_MB} MB.`
        : undefined
    )
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="document-file">File</Label>
        <Input
          id="document-file"
          name="file"
          type="file"
          required
          accept={acceptedExtensions.join(",")}
          onChange={onFileChange}
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">
          {acceptedExtensions.join(", ")} — up to {MAX_MB} MB.
        </p>
        {tooLarge ? (
          <p className="text-sm text-destructive" role="status">
            {tooLarge}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="document-type">Type</Label>
        <Select
          value={documentType}
          onValueChange={setDocumentType}
          disabled={pending}
        >
          <SelectTrigger id="document-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/*
              Straight off the map — the offered order is its key order, and a
              `SelectItem` value is a `string`, so nothing here needs the map's
              keys narrowed back to `DocumentType`.
            */}
            {Object.entries(DOCUMENT_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/*
          A Radix Select renders a button, not a <select>, so its value never
          reaches FormData on its own. This hidden input is what actually
          submits — omitting it is the quiet way this posts no type at all, and
          the server would simply record the document as unlabelled.
        */}
        <input type="hidden" name="documentType" value={documentType} />
        {chosen ? (
          <p className="text-sm text-muted-foreground">
            Guessed from the file name. Change it if that is wrong.
          </p>
        ) : null}
      </div>

      <div>
        <SubmitButton
          pending={pending}
          disabled={Boolean(tooLarge)}
          label="Upload"
          pendingLabel="Uploading…"
        />
      </div>
    </>
  )
}
