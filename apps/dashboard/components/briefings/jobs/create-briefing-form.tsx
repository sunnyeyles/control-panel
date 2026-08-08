"use client"

import { useActionState } from "react"
import { StarsIcon } from "lucide-react"

import { ActionAlert } from "@/components/forms/action-alert"
import { ActionError } from "@/components/forms/action-error"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import {
  createJobAction,
  suggestCriteriaAction,
} from "@/app/(app)/briefings/jobs/actions"
import { IntervalField } from "@/components/briefings/jobs/interval-field"
import { IDLE } from "@/lib/actions/action-state"
import {
  SUGGESTION_IDLE,
  type SuggestedCriteria,
} from "@/lib/jobs/criteria-suggestion"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

/** What the criteria fields start from before anything has been suggested. */
const NOTHING_SUGGESTED: SuggestedCriteria = {
  titles: "",
  locations: "",
  keywords: "",
}

/**
 * Create a briefing, optionally starting from what a resume says.
 *
 * **Only the create action lives here; the draft below it owns the
 * suggestion.** The split is what makes one `key` do all the resetting. A
 * successful create remounts {@link BriefingDraft} wholesale, which discards the
 * suggestion along with every field — because after a briefing has been created
 * the previous CV reading is spent, and leaving it in the boxes would offer the
 * criteria that were *just* saved as the starting point for the next briefing.
 * Keeping `createState` out here is what lets that remount happen without also
 * throwing away the success message that says the briefing was created.
 *
 * An error state carries the previous key forward — see `carryResetKey` — so
 * this key holds still through a failure. Keying on `status === "success"`
 * instead would remount everything and discard what the user typed, at the exact
 * moment they are being told to fix one field of it.
 */
export function CreateBriefingForm() {
  const [createState, createAction, creating] = useActionState(
    createJobAction,
    IDLE
  )

  const createKey =
    createState.status === "idle" ? "new" : (createState.resetKey ?? "new")

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <BriefingDraft
        key={createKey}
        createAction={createAction}
        creating={creating}
      />

      <ActionAlert state={createState} />
    </div>
  )
}

/**
 * One unsaved briefing: the suggest button, and the fields it fills.
 *
 * **The suggestion hook lives here rather than in the parent, and that placement
 * is the whole reset story.** Everything this component holds — the suggested
 * criteria, the name, the interval — is exactly what a successful create should
 * clear, so being remounted by the parent's `key` clears all of it at once, with
 * no effect and no third piece of state tracking whether a suggestion has been
 * spent.
 *
 * **The suggestion is a value the fields are rendered *from*, not something that
 * happens *to* them.** So it has to be readable during the render that produces
 * them, which is why the button is not pushed further down into a child: the
 * suggested criteria would then arrive in that child and have to be handed
 * upwards, and the only way to do that is a `setState` inside an effect — which
 * this repo's `react-hooks/set-state-in-effect` rule flags, and which
 * `lib/actions/action-state.ts` explains at length. A reset is derived from an
 * action's own result, never re-applied from an effect.
 */
function BriefingDraft({
  createAction,
  creating,
}: {
  createAction: (formData: FormData) => void
  creating: boolean
}) {
  const [suggestState, suggestAction, suggesting] = useActionState(
    suggestCriteriaAction,
    SUGGESTION_IDLE
  )

  const suggested =
    suggestState.status === "success"
      ? suggestState.criteria
      : NOTHING_SUGGESTED

  /*
    The criteria fields are keyed and the name field is not, and that asymmetry
    is the point. A suggestion replaces titles, locations and keywords — that is
    what it is for — but the name is the user's, typed before they pressed the
    button and not derivable from a CV. Keying the name on the suggestion too
    would throw that name away the instant one landed, which reads as the form
    having cleared itself for no reason.
  */
  const suggestKey =
    suggestState.status === "success" ? suggestState.resetKey : "none"

  return (
    <>
      {/*
        Its own <form>, and it has to be: a form cannot contain a form, so the
        suggest button could not sit among the fields it fills even if that were
        the tidiest place for it. `example-letter-import.tsx` is a separate form
        for the same pair of reasons — suggesting is not saving, and two submit
        buttons in one form make the Enter key ambiguous.

        It posts no fields at all. The document is chosen server-side (the newest
        one labelled Resume), so there is nothing to pick and nothing to smuggle
        across in a hidden input.
      */}
      <form action={suggestAction} className="flex flex-col gap-2">
        <div>
          <SubmitButton
            pending={suggesting}
            icon={<StarsIcon data-icon="inline-start" />}
            label="Suggest from my resume"
            pendingLabel="Reading your resume…"
            variant="secondary"
          />
        </div>

        <p className="text-sm text-muted-foreground">
          Reads the newest document you labelled Resume and proposes criteria
          for you to edit. Nothing is saved until you press Create briefing.
        </p>

        {/*
          The extractor's own remarks about the extraction — most often "your CV
          does not state a location". Without them, a blank Locations box after a
          successful suggestion looks identical to a suggestion that failed
          halfway through.
        */}
        {suggestState.status === "success" && suggestState.notes ? (
          <p className="text-sm text-muted-foreground">{suggestState.notes}</p>
        ) : null}

        {/*
          Narrowed first, then handed to the shared component — and the
          narrowing is what makes that possible at all. Neither `ActionAlert`
          nor `ActionError` can take a `CriteriaSuggestionState`: their prop is
          an `ActionState`, and this union's success case carries criteria
          rather than a `message` (a separate union on purpose — see
          `lib/jobs/criteria-suggestion.ts`). Its *error* case, however, is
          exactly an `ActionState` error, so testing for it here reuses
          `ActionError` without widening anybody's prop type, and without a
          hand-written <p> that would be free to lose the `aria-live` pairing
          the way the two copies `ActionError` replaced did.

          Errors only. A successful suggestion announces itself as three filled
          fields and, when it has one, the note above.
        */}
        {suggestState.status === "error" ? (
          <ActionError state={suggestState} />
        ) : null}
      </form>

      <form action={createAction} className="flex flex-col gap-4">
        <NameField pending={creating} />

        <CriteriaFields
          key={suggestKey}
          suggested={suggested}
          // Disabled while a suggestion is in flight as well as while creating:
          // these are the fields the suggestion is about to overwrite, so typing
          // into them meanwhile is work about to be thrown away.
          pending={creating || suggesting}
        />

        <IntervalField idPrefix="briefing-new" pending={creating} />

        <div>
          <SubmitButton
            pending={creating}
            label="Create briefing"
            pendingLabel="Creating…"
          />
        </div>
      </form>
    </>
  )
}

function NameField({ pending }: { pending: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="briefing-name">Name</Label>
      <Input
        id="briefing-name"
        name="name"
        required
        maxLength={80}
        placeholder="Morning briefing"
        disabled={pending}
      />
      <p className="text-sm text-muted-foreground">
        Just a label, and it has to be unique among your briefings.
      </p>
    </div>
  )
}

/**
 * The three fields that describe what to search for.
 *
 * Grouped into one component because they share a `key`: they are what a
 * suggestion replaces, all at once, and remounting them is how the suggested
 * values become the values in the boxes. `defaultValue` and not `value` — the
 * suggestion is a starting point to be edited by hand, so the inputs stay
 * uncontrolled and React never fights the user for the caret.
 */
function CriteriaFields({
  suggested,
  pending,
}: {
  suggested: SuggestedCriteria
  pending: boolean
}) {
  return (
    <>
      {/*
        Required, not optional, and not a nicety. The worker's config schema
        needs at least one title and one location — a briefing created without
        them would claim its first slot, spend the claim, and then fail on a
        config it cannot read. See lib/jobs/search-criteria.ts.
      */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="briefing-titles">Role titles</Label>
        <Input
          id="briefing-titles"
          name="titles"
          required
          defaultValue={suggested.titles}
          placeholder="senior backend engineer, staff engineer"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">
          Comma separated. These are what the scout searches for.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="briefing-locations">Locations</Label>
        <Input
          id="briefing-locations"
          name="locations"
          required
          defaultValue={suggested.locations}
          placeholder="Sydney, Remote (Australia)"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">Comma separated.</p>
      </div>

      {/*
        Optional, unlike the two above, and the missing `required` is the whole
        difference. The worker treats keywords as a hint about what makes a role
        a better match, so a briefing without them is a briefing that matches on
        title and location alone — a worse search, never a broken one.
      */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="briefing-keywords">Keywords</Label>
        <Input
          id="briefing-keywords"
          name="keywords"
          defaultValue={suggested.keywords}
          placeholder="TypeScript, Postgres, AWS"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">
          Comma separated, and optional. Technologies or specialisms that make a
          role a better match.
        </p>
      </div>
    </>
  )
}
