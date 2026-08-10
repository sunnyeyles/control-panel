/**
 * What "add a Posting by link" hands back to `useActionState`.
 *
 * **This module has no imports, for the reason `lib/actions/action-state.ts`
 * and `lib/jobs/criteria-suggestion.ts` have none**: a client component needs
 * the initial state, while the action module beside it imports `@workspace/db`
 * and `@workspace/agents` — so importing the state from there would pull Prisma
 * and an agent runtime into the browser bundle for the sake of one object
 * literal.
 *
 * **A second union rather than a reuse of `ActionState`, on the same grounds
 * `CriteriaSuggestionState` is one.** That module argues for one shared union,
 * and the argument is about duplication: the documents and briefings copies
 * were byte-identical apart from their names. This shape is not a copy — it
 * *carries a payload*, because a fourth outcome has something to show. Widening
 * the shared union with a `duplicate` case nobody else returns would push this
 * feature's shape onto every action in the app, and `ActionAlert` would render
 * the new status as a destructive error because that is its `else`.
 *
 * Four outcomes, so `status` rather than `ok` — `NAMING.md` R6.
 *
 * Serializable by construction, like both of those: this crosses the RSC
 * boundary, so everything here is a string.
 */

/**
 * The advertisement already on the list that the pasted one looks like.
 *
 * `View` and not `Row` — `NAMING.md` R5 — and the suffix is doing real work
 * here: `PostingIdentityRow` in `@workspace/db` carries `firstSeenAt` as a
 * `Date`, which is exactly the value that fails at runtime rather than at
 * compile time when it crosses to a client component. {@link addedOn} is that
 * date already rendered.
 */
export interface DuplicatePostingView {
  /** The Posting's derived id, so the caller can link to the row. */
  postingId: string
  title: string
  company: string
  /**
   * Shown because it is the field most likely to tell the two apart. The match
   * is made on company and title alone — see `duplicate-posting.ts` — so a
   * genuinely different opening in another city reaches this dialog, and the
   * location is what lets somebody say so at a glance.
   */
  location: string
  /** Where the one already tracked came from. Usually the other board. */
  url: string
  /** Already formatted. A `Date` here would not survive the boundary. */
  addedOn: string
}

export type AddByLinkState =
  | { status: "idle" }
  | {
      status: "error"
      message: string
      /** The previous success's key, carried forward — see `carryResetKey`. */
      resetKey?: string
    }
  | {
      status: "success"
      message: string
      /**
       * Distinct per success, used by the form as a React `key` to remount the
       * field and clear it. Same mechanism `ActionState.resetKey` documents.
       */
      resetKey: string
    }
  | {
      status: "duplicate"
      message: string
      /** What it looks like. Rendered beside the choice. */
      duplicate: DuplicatePostingView
      /**
       * The link that was pasted, handed back so the form can resubmit it.
       *
       * ⚠️ **This is the whole of what the confirmation carries, and that is
       * deliberate.** The advertisement's fields are *not* returned for the
       * client to send back on the second submit: they came out of a model, and
       * a Server Function is reachable by direct POST, so accepting them would
       * let a crafted request write any title, company and payload it liked.
       * The URL is the one value this path already takes from the form and
       * re-derives everything from, so handing it back adds no new trust.
       *
       * The cost of that choice is a second fetch and a second model call when
       * somebody chooses to add anyway. See the note on `CONFIRM_FIELD` in
       * `add-by-link-actions.ts`.
       */
      url: string
      /** Carried forward unchanged, so the field is not remounted mid-choice. */
      resetKey?: string
    }

export const ADD_BY_LINK_IDLE: AddByLinkState = { status: "idle" }

/**
 * The form field that says "I looked at the duplicate and I want it anyway".
 *
 * Here rather than beside the action for this module's whole reason to exist:
 * the form that sets it is a client component, and `add-by-link-actions.ts`
 * imports `@workspace/db` and `@workspace/agents`.
 *
 * ⚠️ **It carries the pasted URL, not a boolean, and the action checks that it
 * matches the URL being added.** A Server Function is reachable by direct POST,
 * so a bare `confirm=1` would be a permanent opt-out of the check that any
 * client could set once and keep sending. Tying the confirmation to the exact
 * link it was shown for means it can only ever authorise the one advertisement
 * the person actually saw the warning about.
 */
export const CONFIRM_FIELD = "confirmDuplicate"
