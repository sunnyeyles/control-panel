"use client"

import { useActionState, useState } from "react"

import { uploadDocumentAction } from "@/app/documents/actions"
import { IDLE } from "@/lib/documents/action-state"
import { MAX_DOCUMENT_BYTES } from "@/lib/documents/upload-validation"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"

/**
 * The document types, as label and value.
 *
 * Restated here rather than imported from `@workspace/user-storage`, because
 * this is a client component and that package pulls in the AWS SDK — seven
 * strings are not worth shipping an SDK to the browser for. The server
 * validates against its own copy and never trusts this one, so a drift shows up
 * as a rejected label rather than as a mislabelled document.
 */
const DOCUMENT_TYPE_OPTIONS = [
  { value: "resume", label: "Resume" },
  { value: "cover-letter", label: "Cover letter" },
  { value: "portfolio", label: "Portfolio" },
  { value: "reference", label: "Reference" },
  { value: "other", label: "Other" },
] as const

const MAX_MB = (MAX_DOCUMENT_BYTES / (1024 * 1024)).toFixed(0)

/**
 * Guess what a document is from what it is called.
 *
 * This is the whole of what makes the type field feel like a confirmation
 * rather than a chore: a file called `cv.pdf` or `alice-resume.pdf` arrives
 * with the right answer already selected and the user never touches it. Order
 * matters — "cover letter (from my resume pack).pdf" should read as a cover
 * letter, so that test comes first.
 */
function inferDocumentType(filename: string): string {
  const name = filename.toLowerCase()

  if (/cover|letter/.test(name)) return "cover-letter"
  if (/portfolio/.test(name)) return "portfolio"
  if (/reference|referee|recommendation/.test(name)) return "reference"

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
        fields — a fresh empty file input and a fresh inferred type. That is the
        form reset, and doing it this way means there is **no effect here at
        all**: resetting from `useEffect` would call `setState` inside it, which
        cascades a render and is what `react-hooks/set-state-in-effect` warns
        about. One reset per success, never one per re-render.

        ⚠️ **Read the nonce on every non-idle state, not only on a success.** An
        error state carries the previous success's nonce forward precisely so
        this key holds still; keying on `status === "success"` instead sends it
        back to "new" the moment an upload fails, remounting the fields and
        discarding the file the user picked while telling them to try again.
      */}
      <UploadFields
        key={state.status === "idle" ? "new" : (state.nonce ?? "new")}
        acceptedExtensions={acceptedExtensions}
        pending={pending}
      />

      {state.status !== "idle" ? (
        <Alert
          variant={state.status === "success" ? "default" : "destructive"}
          role="status"
          aria-live="polite"
        >
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
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
            {DOCUMENT_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
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
        <Button type="submit" disabled={pending || Boolean(tooLarge)}>
          {/*
            A spinner, not a progress bar. A Server Action surfaces no upload
            progress events, so a bar would either be fake or sit at zero —
            both of which read as the app having hung.
          */}
          {pending ? <Spinner /> : null}
          {pending ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </>
  )
}
