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
 * The extracted criteria, already comma-joined and ready for an `<input>`.
 *
 * Strings rather than arrays because that is what the form fields take, and
 * because `searchCriteriaSchema` parses the same comma-separated shape on the
 * way back in — the suggestion is edited by hand before it is submitted, so it
 * has to arrive in the format a person edits.
 *
 * Empty string means "the CV did not say", and is a real answer rather than a
 * missing one — most obviously for `locations`, which a CV often omits.
 */
export interface SuggestedCriteria {
  titles: string
  locations: string
  keywords: string
}

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
