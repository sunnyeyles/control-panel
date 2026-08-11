/**
 * What the "suggest criteria from my resume" action hands back to
 * `useActionState`.
 *
 * **This module has no imports, for the reason `lib/actions/action-state.ts`
 * has none**: a client component needs the initial state, while the action
 * module beside it imports `@workspace/agents` and `@workspace/user-storage` —
 * so importing the state from there would pull an agent runtime and the AWS SDK
 * into the browser bundle for the sake of one object literal.
 *
 * **A second union rather than a reuse of `ActionState`, deliberately.** That
 * module argues for one shared union, and the argument is about duplication:
 * the documents and briefings copies were byte-identical apart from their
 * names, so two copies only created somewhere for them to drift apart. This
 * shape is not a copy — it *carries a payload*, because the whole point of the
 * action is to return criteria the form then renders. Widening the shared union
 * with an optional payload nobody else sets would push this feature's shape
 * onto every action in the app.
 *
 * Serializable by construction, like the shared union: this crosses the RSC
 * boundary, so everything here is a string.
 */

/**
 * The extracted criteria, ready for the controls that render them.
 *
 * `locations` and `keywords` are comma-joined because that is what their fields
 * take, and because `searchCriteriaSchema` parses the same comma-separated
 * shape on the way back in — the suggestion is edited by hand before it is
 * submitted, so it has to arrive in the format a person edits. An empty string
 * means "the CV did not say", and is a real answer rather than a missing one:
 * most obviously for `locations`, which a CV often omits.
 *
 * ⚠️ **`titles` is a list, and the asymmetry is the feature.** It used to be
 * joined like its neighbours and written straight into the field. It is now
 * offered as one button per title, for two reasons that point the same way: a
 * user wants three of five proposed titles far more often than all five, and a
 * briefing may hold at most `MAX_ROLE_TITLES` of them — so a bulk fill of a
 * six-title extraction would drop the field into an invalid state the instant
 * the suggestion landed, having thrown away whatever was there before.
 */
export interface SuggestedCriteria {
  titles: readonly string[]
  locations: string
  keywords: string
}

/**
 * What the "suggest adjacent role titles" action hands back.
 *
 * A third union rather than a reuse of either neighbour, for the reason set out
 * at the top of this file: it carries a payload, and the payload is not the one
 * {@link CriteriaSuggestionState} carries. This action proposes titles *only*,
 * against the ones already chosen, and returning a `SuggestedCriteria` with two
 * fields permanently blank would invite a caller to render them.
 *
 * ⚠️ **No `resetKey`.** Nothing here is written into a field — the titles are
 * rendered as buttons, and a click appends one. There is nothing to remount, and
 * a key would be an invitation to remount the field this action must not
 * disturb.
 */
export type RoleTitleSuggestionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "success"
      titles: readonly string[]
      /**
       * Why the list is short or empty, when the suggester says so.
       *
       * Load-bearing for the empty case in particular: an empty row of buttons
       * is indistinguishable from a suggestion that failed silently, and "you
       * already have the titles worth searching for" is a genuinely useful
       * answer.
       */
      notes?: string
    }

export const ROLE_TITLES_IDLE: RoleTitleSuggestionState = { status: "idle" }

export type CriteriaSuggestionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "success"
      criteria: SuggestedCriteria
      /**
       * Anything the extractor wants to say about the extraction itself —
       * "your CV does not state a location", most often.
       *
       * Rendered beside the fields. Without it a blank Locations box after a
       * successful suggestion is indistinguishable from a suggestion that
       * failed halfway.
       */
      notes?: string
      /**
       * Distinct per success, used by the form as part of a React `key` so the
       * criteria fields remount and pick up the new `defaultValue`.
       *
       * The same mechanism `ActionState.resetKey` documents — one reset per
       * success, derived from the action's result rather than from an effect.
       * ⚠️ It keys the *criteria* fields only: the name field is keyed on the
       * create action alone, or a suggestion would discard a name the user had
       * already typed.
       */
      resetKey: string
    }

export const SUGGESTION_IDLE: CriteriaSuggestionState = { status: "idle" }
