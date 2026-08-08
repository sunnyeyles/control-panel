"use client"

import { useActionState, useState } from "react"
import { ActionError } from "@/components/forms/action-error"

import { deleteDocumentAction } from "@/app/(app)/documents/actions"
import { IDLE } from "@/lib/actions/action-state"
import { Button } from "@workspace/ui/components/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { Trash2Icon } from "lucide-react"

/**
 * Delete one document, behind a confirmation.
 *
 * Proportionate: the bucket is versioned, so this writes a delete marker and
 * the previous version survives until the 365-day noncurrent-expiry rule
 * removes it. The confirmation is here to prevent a misclick, not to guard
 * something irreversible.
 */
export function DeleteDocumentButton({
  resumeId,
  displayName,
}: {
  resumeId: string
  displayName: string
}) {
  const [state, formAction, pending] = useActionState(
    deleteDocumentAction,
    IDLE
  )
  const [open, setOpen] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${displayName}`}
          disabled={pending}
        >
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this document?</AlertDialogTitle>
          <AlertDialogDescription>
            {displayName} will be removed from your documents. Previous versions
            are retained for a year.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form action={formAction}>
          {/*
            Untrusted, and validated server-side. What it cannot do is name
            another user: the row is looked up by `(id, userId)` with the userId
            coming from the session, so a tampered value here can only ever
            address something the caller owns.

            The extension used to be a second field beside this one. It comes
            off the row now — the object key is built from what the database
            holds rather than from what the browser sent back.
          */}
          <input type="hidden" name="resumeId" value={resumeId} />

          <ActionError state={state} className="mb-4" />

          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <SubmitButton
              pending={pending}
              variant="destructive"
              label="Delete"
            />
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
