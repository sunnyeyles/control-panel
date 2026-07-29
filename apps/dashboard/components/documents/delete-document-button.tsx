"use client"

import { useActionState, useState } from "react"

import { deleteDocumentAction } from "@/app/documents/actions"
import { IDLE } from "@/lib/documents/action-state"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import { Spinner } from "@workspace/ui/components/spinner"
import { Trash2Icon } from "lucide-react"

/**
 * Delete one document, behind a confirmation.
 *
 * A plain `Dialog` rather than `alert-dialog`, which this repo's `packages/ui`
 * does not have. Proportionate: the bucket is versioned, so this writes a
 * delete marker and the previous version survives until the 365-day
 * noncurrent-expiry rule removes it. The confirmation is here to prevent a
 * misclick, not to guard something irreversible.
 */
export function DeleteDocumentButton({
  resumeId,
  extension,
  displayName,
}: {
  resumeId: string
  extension: string
  displayName: string
}) {
  const [state, formAction, pending] = useActionState(
    deleteDocumentAction,
    IDLE
  )
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${displayName}`}
          disabled={pending}
        >
          <Trash2Icon />
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this document?</DialogTitle>
          <DialogDescription>
            {displayName} will be removed from your documents. Previous versions
            are retained for a year.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction}>
          {/*
            Both fields are untrusted, and both are validated server-side. What
            they cannot do is name another user: the key is built from the
            session's own userId, so a tampered value here can only ever address
            something in the caller's own prefix.
          */}
          <input type="hidden" name="resumeId" value={resumeId} />
          <input type="hidden" name="extension" value={extension} />

          {state.status === "error" ? (
            <p className="mb-4 text-sm text-destructive" role="status">
              {state.message}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Spinner /> : null}
              Delete
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
