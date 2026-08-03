"use client"

import { useActionState } from "react"

import { draftCoverLetterAction } from "@/app/(app)/briefings/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@/components/forms/submit-button"
import { IDLE } from "@/lib/actions/action-state"

/**
 * Draft a cover letter for one Posting.
 *
 * The form carries **identifiers only** — the Run it was found in and the
 * Posting's derived id — and never the Posting itself. That is the security
 * property, not a payload optimisation: a Posting body accepted from form data
 * would let a caller put text of their choosing into a document stored in the
 * user's own voice. The action re-reads the Posting out of the Run's stored
 * Findings and matches it by id, and a test submits a `posting` field to prove
 * it is ignored.
 *
 * Both fields are untrusted on the way in. Neither can name a *user*: the
 * storage key is built from the session's own id, and the Run's ownership is
 * checked against the caller before anything is read.
 */
export function DraftCoverLetterButton({
  runId,
  postingId,
  title,
  drafted = false,
}: {
  runId: string
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
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="postingId" value={postingId} />

      <div>
        {/*
          `SubmitButton` omits `children` from its props on purpose — the label
          and the pending spinner are its whole content — so there is no icon
          here. The label carries the meaning.
        */}
        <SubmitButton
          pending={pending}
          variant="outline"
          size="sm"
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
