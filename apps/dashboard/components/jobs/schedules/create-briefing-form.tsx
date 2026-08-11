"use client"

import { useActionState } from "react"
import { StarsIcon } from "lucide-react"

import { ActionAlert } from "@/components/forms/action-alert"
import { ActionError } from "@/components/forms/action-error"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import {
  createJobAction,
  suggestCriteriaAction,
  suggestRoleTitlesAction,
} from "@/app/(app)/jobs/schedules/actions"
import { CriteriaFields } from "@/components/jobs/schedules/criteria-fields"
import { RoleTitleSuggestForm } from "@/components/jobs/schedules/role-title-suggest-form"
import { IntervalField } from "@/components/jobs/schedules/interval-field"
import { useCriteriaDraft } from "@/components/jobs/schedules/use-criteria-draft"
import { IDLE } from "@/lib/actions/action-state"
import {
  ROLE_TITLES_IDLE,
  SUGGESTION_IDLE,
  type RoleTitleSuggestionState,
  type SuggestedCriteria,
} from "@/lib/jobs/criteria-suggestion"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

/** What the criteria fields start from before anything has been suggested. */
const NOTHING_SUGGESTED: SuggestedCriteria = {
  titles: [],
  locations: "",
  keywords: "",
}

/**
 * Create a briefing, optionally starting from what a resume says.
 *
 * **Only the create action lives here; the draft below it owns the
 * suggestions.** The split is what makes one `key` do all the resetting. A
 * successful create remounts {@link BriefingDraft} wholesale, which discards
 * both suggestions along with every field — because after a briefing has been
 * created the previous CV reading is spent, and leaving it in the boxes would
 * offer the criteria that were *just* saved as the starting point for the next
 * briefing. Keeping `createState` out here is what lets that remount happen
 * without also throwing away the success message that says the briefing was
 * created.
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
 * One unsaved briefing: the two suggest buttons, and the fields they fill.
 *
 * **The suggestion hooks live here rather than in the parent, and that
 * placement is the whole reset story.** Everything this component holds — the
 * suggested criteria, the suggested titles, the name, the interval — is exactly
 * what a successful create should clear, so being remounted by the parent's
 * `key` clears all of it at once, with no effect and no third piece of state
 * tracking whether a suggestion has been spent.
 *
 * **A suggestion is a value the fields are rendered *from*, not something that
 * happens *to* them.** So it has to be readable during the render that produces
 * them, which is why the buttons are not pushed further down into a child: the
 * suggested values would then arrive in that child and have to be handed
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

  const [titlesState, titlesAction, suggestingTitles] = useActionState(
    suggestRoleTitlesAction,
    ROLE_TITLES_IDLE
  )

  const suggested =
    suggestState.status === "success"
      ? suggestState.criteria
      : NOTHING_SUGGESTED

  /*
    The criteria fields are keyed and the name field is not, and that asymmetry
    is the point. A suggestion replaces locations and keywords — that is what it
    is for — but the name is the user's, typed before they pressed the button
    and not derivable from a CV. Keying the name on the suggestion too would
    throw that name away the instant one landed, which reads as the form having
    cleared itself for no reason.

    ⚠️ **Titles is no longer among what a suggestion replaces**, and so is no
    longer among what this key resets. The extractor's titles arrive as buttons
    now rather than as text — `SuggestedCriteria` says why — so a suggestion
    landing must leave a half-typed title exactly where it was.
  */
  const suggestKey =
    suggestState.status === "success" ? suggestState.resetKey : "none"

  const pending = creating || suggesting

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
          for you to edit. Role titles arrive as buttons to pick from; nothing
          is saved until you press Create briefing.
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

          Errors only. A successful suggestion announces itself as filled fields,
          a row of title buttons and, when it has one, the note above.
        */}
        {suggestState.status === "error" ? (
          <ActionError state={suggestState} />
        ) : null}
      </form>

      <CreateFields
        key={suggestKey}
        suggested={suggested}
        titlesState={titlesState}
        titlesAction={titlesAction}
        suggestingTitles={suggestingTitles}
        createAction={createAction}
        creating={creating}
        pending={pending}
      />
    </>
  )
}

/**
 * The create form proper, remounted whenever a resume suggestion lands.
 *
 * Split out from {@link BriefingDraft} so that `useCriteriaDraft` — which seeds
 * its state from the suggestion — is *inside* the thing the `suggestKey`
 * remounts. A hook cannot be re-seeded by a changed prop, so the remount is how
 * a suggestion reaches it, which is the same mechanism `defaultValue` relies on
 * one level down.
 */
function CreateFields({
  suggested,
  titlesState,
  titlesAction,
  suggestingTitles,
  createAction,
  creating,
  pending,
}: {
  suggested: SuggestedCriteria
  titlesState: RoleTitleSuggestionState
  titlesAction: (formData: FormData) => void
  suggestingTitles: boolean
  createAction: (formData: FormData) => void
  creating: boolean
  pending: boolean
}) {
  const draft = useCriteriaDraft({
    titles: "",
    locations: suggested.locations,
  })

  const adjacent =
    titlesState.status === "success" ? titlesState.titles : undefined

  return (
    <>
      {/*
        A third form, for the same reason the second one exists: it submits the
        titles chosen so far so the suggester knows what *not* to propose, and a
        nested form is not a thing. The hidden input is how that value crosses —
        it is the one field either suggest action reads, and it is the user's own
        text rather than an identity or a document selector.
      */}
      <RoleTitleSuggestForm
        action={titlesAction}
        chosen={draft.titles}
        state={titlesState}
        pending={suggestingTitles || pending}
      />

      <form action={createAction} className="flex flex-col gap-4">
        <NameField pending={creating} />

        <CriteriaFields
          draft={draft}
          suggestedLocations={suggested.locations}
          suggestedKeywords={suggested.keywords}
          titleSuggestions={[
            { source: "From your resume", titles: suggested.titles },
            ...(adjacent
              ? [{ source: "Roles adjacent to these", titles: adjacent }]
              : []),
          ]}
          // Disabled while a suggestion is in flight as well as while creating:
          // these are the fields the suggestion is about to fill, so typing into
          // them meanwhile is work about to be thrown away.
          pending={pending}
          idPrefix="briefing-new"
        />

        <IntervalField idPrefix="briefing-new" pending={creating} />

        <div>
          <SubmitButton
            pending={creating}
            // ⚠️ Disabled on an over-budget sweep, not merely warned about. The
            // action refuses it too — see `readCriteria` — and this is the half
            // that stops the user finding out after a round trip.
            disabled={!draft.fits}
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
