"use client"

import { useActionState } from "react"
import { SparklesIcon } from "lucide-react"

import { generateTailoredResumeAction } from "@/app/(app)/briefings/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { IDLE } from "@/lib/actions/action-state"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * Rewrite the user's CV for one Posting.
 *
 * The form carries **one identifier** — the Posting's derived id — and never the
 * Posting itself. That is the security property, not a payload optimisation: a
 * Posting body accepted from form data would let a caller put text of their
 * choosing into a document that makes factual claims in the user's name. The
 * action re-reads the Posting out of its stored row's payload, and a test
 * submits a `posting` field to prove it is ignored.
 *
 * The one field left is untrusted on the way in and cannot name a *user*: the
 * row is addressed by `(session user, posting id)` and the storage key is built
 * from the session's own id, so a Posting belonging to somebody else cannot be
 * spelled from here at all.
 *
 * Deliberately shaped like `draft-cover-letter-button.tsx` down to the pending
 * label, because the two sit beside each other and a difference in how they
 * behave under a slow model call would read as one of them being broken.
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
   * The label only — it changes nothing the action does, which already
   * supersedes the stored document on every generation because the key holds no
   * time. A button that says "Generate tailored resume" beside one generated
   * last week offers a first attempt at something already done, and the user
   * would have to click it, and spend a model call, to discover otherwise.
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
