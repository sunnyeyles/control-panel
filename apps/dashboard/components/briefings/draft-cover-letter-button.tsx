"use client"

import { useActionState } from "react"
import { StarsIcon } from "lucide-react"

import { draftCoverLetterAction } from "@/app/(app)/briefings/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { IDLE } from "@/lib/actions/action-state"

/**
 * Draft a cover letter for one Posting.
 *
 * The form carries **one identifier** — the Posting's derived id — and never
 * the Posting itself. That is the security property, not a payload
 * optimisation: a Posting body accepted from form data would let a caller put
 * text of their choosing into a document stored in the user's own voice. The
 * action re-reads the Posting out of its stored row's payload, and a test
 * submits a `posting` field to prove it is ignored.
 *
 * ⚠️ **No Run travels through here, and that is deliberate.** This form used to
 * carry the Run the advertisement was found in, because the action re-read the
 * Posting out of that Run's Findings. It reads `postings.payload` now, so the
 * Run is gone from the client surface entirely — one less untrusted field, and
 * one less way for a page open in another tab to name a Run that has since
 * stopped holding anything.
 *
 * The one field left is untrusted on the way in and cannot name a *user*: the
 * row is addressed by `(session user, posting id)` and the storage key is built
 * from the session's own id, so a Posting belonging to somebody else cannot be
 * spelled from here at all.
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
   * The label only — it changes nothing the action does, which already
   * supersedes the stored letter on every draft because the key holds no time.
   * A button that says "Draft cover letter" beside a letter drafted last week
   * offers a first draft for something already drafted, and the user would have
   * to click it, and spend a model call, to discover otherwise.
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
