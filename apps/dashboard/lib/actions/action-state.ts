/**
 * What every Server Action in this app hands back to `useActionState`.
 *
 * **This module has no imports, and that is the point.** A client component
 * needs the initial state, while the action modules import `@workspace/db` and
 * `@workspace/user-storage` — importing it from beside an action would pull
 * `pg`, `cron-parser` or the AWS SDK into the browser bundle for one literal.
 *
 * ⚠️ Serializable by construction: the value crosses the RSC boundary, so an
 * `Error`, a `Date` or a class instance fails at runtime rather than at compile
 * time. In particular a `Job` must never be returned — `nextRunAt` is a `Date`.
 *
 * One union for every feature: the documents and briefings copies were
 * byte-identical apart from their names.
 */
export type ActionState =
  | { status: "idle" }
  | {
      status: "error"
      message: string
      /**
       * The **previous** success's key, carried forward unchanged — see
       * {@link carryResetKey}.
       *
       * Absent when nothing has succeeded yet, which is the only case where
       * there is nothing to preserve.
       */
      resetKey?: string
    }
  | {
      status: "success"
      message: string
      /**
       * Distinct per successful action, used by a form as a React `key` to
       * remount and clear its fields.
       *
       * That resets a form **without an effect** — resetting from a `useEffect`
       * means `setState` inside it, which cascades a render and which the repo's
       * `react-hooks/set-state-in-effect` rule flags. Deriving it from the
       * action's own result is correct by construction: one reset per success,
       * never one per re-render.
       *
       * Not an identifier and not cryptographic. It has to be *different after
       * every success and stable across everything else* — a new row's uuid or a
       * fresh `crypto.randomUUID()` both qualify.
       */
      resetKey: string
    }

export const IDLE: ActionState = { status: "idle" }

/**
 * An error state that preserves whatever reset key the previous state held.
 *
 * Not decoration: a form keys its fields on `resetKey`, so a value that
 * disappeared here would be a value that *changed*, remounting the fields and
 * throwing away what the user typed at the exact moment they are told to try
 * again. Takes the whole previous state rather than a key so a caller cannot
 * pass the wrong one, and so the `idle` case is handled here once.
 */
export function carryResetKey(
  previous: ActionState,
  message: string
): ActionState {
  const resetKey = previous.status === "idle" ? undefined : previous.resetKey

  return { status: "error", message, ...(resetKey ? { resetKey } : {}) }
}
