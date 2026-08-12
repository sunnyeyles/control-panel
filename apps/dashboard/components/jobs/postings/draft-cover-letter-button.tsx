"use client"

import { useActionState } from "react"
import { StarsIcon } from "lucide-react"

import { draftCoverLetterAction } from "@/app/(app)/jobs/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { IDLE } from "@/lib/actions/action-state"

/**
 * Draft a cover letter for one Posting.
 *
 * ⚠️ **The form carries one identifier and never the Posting itself.** That is
 * the security property: a Posting body from form data would let a caller put
 * text of their choosing into a document stored in the user's own voice. The
 * action re-reads it from the stored row's payload, and a test submits a
 * `posting` field to prove it is ignored.
 *
 * No Run travels through here either — the action reads `postings.payload`, so
 * a page open in another tab cannot name a Run that has stopped holding
 * anything. The one field left cannot name a *user*: the row is addressed by
 * `(session user, posting id)`, keyed from the session's own id.
 */
export function DraftCoverLetterButton({
  postingId,
  title,
  drafted = false,
}: {
  postingId: string
  /** Only for the accessible label, so several buttons on a page differ. */
  title: string
  /**
   * Whether a letter for this Posting already exists.
   *
   * The label only — the action supersedes the stored letter on every draft
   * regardless, since the key holds no time. Without it the button offers a
   * first draft for something already drafted, discoverable only by spending a
   * model call.
   */
  drafted?: boolean
}) {
  const [state, formAction, pending] = useActionState(
    draftCoverLetterAction,
    IDLE
  )

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="postingId" value={postingId} />

      <div>
        <SubmitButton
          pending={pending}
          variant="outline"
          size="sm"
          icon={<StarsIcon data-icon="inline-start" />}
          label={drafted ? "Replace this draft" : "Draft cover letter"}
          pendingLabel="Drafting…"
          aria-label={
            drafted
              ? `Replace the drafted cover letter for ${title}`
              : `Draft a cover letter for ${title}`
          }
        />
      </div>

      <ActionAlert state={state} />
    </form>
  )
}
