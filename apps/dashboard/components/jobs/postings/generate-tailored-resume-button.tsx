"use client"

import { useActionState } from "react"
import { SparklesIcon } from "lucide-react"

import { generateTailoredResumeAction } from "@/app/(app)/jobs/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { IDLE } from "@/lib/actions/action-state"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * Rewrite the user's CV for one Posting.
 *
 * ⚠️ **The form carries one identifier and never the Posting itself.** That is
 * the security property: a Posting body from form data would let a caller put
 * text of their choosing into a document making factual claims in the user's
 * name. The action re-reads it from the stored row's payload, and a test
 * submits a `posting` field to prove it is ignored. The one field left cannot
 * name a *user* — the row is addressed by `(session user, posting id)`.
 *
 * Deliberately shaped like `draft-cover-letter-button.tsx` down to the pending
 * label: the two sit beside each other, and a difference under a slow model
 * call would read as one of them being broken.
 */
export function GenerateTailoredResumeButton({
  postingId,
  title,
  generated = false,
}: {
  postingId: string
  /** Only for the accessible label, so several buttons on a page differ. */
  title: string
  /**
   * Whether a tailored resume for this Posting already exists.
   *
   * The label only — the action supersedes the stored document on every
   * generation regardless, since the key holds no time. Without it the button
   * offers a first attempt at something already done, discoverable only by
   * spending a model call.
   */
  generated?: boolean
}) {
  const [state, formAction, pending] = useActionState(
    generateTailoredResumeAction,
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
          icon={<SparklesIcon data-icon="inline-start" />}
          label={generated ? "Regenerate" : "Generate tailored resume"}
          pendingLabel="Tailoring…"
          aria-label={
            generated
              ? `Regenerate the tailored resume for ${title}`
              : `Generate a tailored resume for ${title}`
          }
        />
      </div>

      <ActionAlert state={state} />
    </form>
  )
}
