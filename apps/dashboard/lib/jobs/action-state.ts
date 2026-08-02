/**
 * What a briefing action hands back to `useActionState`.
 *
 * Its own module, with no imports, for the same reason as
 * `lib/documents/action-state.ts`: a client component needs the initial state,
 * and `job-actions.ts` imports `@workspace/db` — so importing the state from
 * there would pull `pg` and `cron-parser` at a browser-bound module for the sake
 * of one object literal.
 *
 * Serializable by construction: a Server Action's return value crosses the RSC
 * boundary, so an Error, a Date or a class instance here would fail at runtime
 * rather than at compile time. In particular a `Job` must never be returned —
 * `nextRunAt` is a `Date`.
 */
export type JobActionState =
  | { status: "idle" }
  | {
      status: "error"
      message: string
      /**
       * The **previous** success's nonce, carried forward unchanged.
       *
       * The create form keys its fields on the nonce, so a value that
       * disappeared here would be a value that *changed* — and the fields would
       * remount, discarding what the user typed at the exact moment they are
       * being told to fix it.
       */
      nonce?: string
    }
  | {
      status: "success"
      message: string
      /**
       * Distinct per successful action, used by the create form as a React
       * `key` to remount and clear its fields.
       *
       * That is what resets the form **without an effect** — resetting from a
       * `useEffect` means `setState` inside it, which the repo's own
       * `react-hooks/set-state-in-effect` rule flags.
       */
      nonce: string
    }

export const IDLE: JobActionState = { status: "idle" }
