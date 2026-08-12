/**
 * What the "suggest criteria from my resume" action hands back to
 * `useActionState`.
 *
 * ⚠️ **No imports, for the reason `lib/actions/action-state.ts` has none**: a
 * client component needs the initial state, and the action module beside it
 * imports `@workspace/agents` and `@workspace/user-storage` — so importing from
 * there would pull an agent runtime and the AWS SDK into the browser bundle for
 * one object literal.
 *
 * A second union rather than a reuse of `ActionState` because this one *carries
 * a payload*; widening the shared union with an optional payload nobody else
 * sets would push this feature's shape onto every action in the app.
 * Serializable by construction — it crosses the RSC boundary.
 */

/**
 * The extracted criteria, ready for the controls that render them.
 *
 * `locations` and `keywords` are comma-joined because that is what their fields
 * take and what `searchCriteriaSchema` parses on the way back in — a suggestion
 * is edited by hand before submitting. An empty string means "the CV did not
 * say", a real answer rather than a missing one.
 *
 * ⚠️ **`titles` is a list, and the asymmetry is the feature.** It is offered as
 * one button per title: a briefing may hold at most `MAX_ROLE_TITLES`, so bulk
 * filling a six-title extraction would drop the field into an invalid state
 * having thrown away whatever was there before.
 */
export interface SuggestedCriteria {
  titles: readonly string[]
  locations: string
  keywords: string
}

/**
 * What the "suggest adjacent role titles" action hands back.
 *
 * A third union rather than a reuse of either neighbour: this proposes titles
 * *only*, against the ones already chosen, and a `SuggestedCriteria` with two
 * fields permanently blank would invite a caller to render them.
 *
 * ⚠️ **No `resetKey`.** The titles are buttons and a click appends one, so
 * there is nothing to remount — a key would invite remounting the very field
 * this action must not disturb.
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
