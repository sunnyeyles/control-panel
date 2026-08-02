/**
 * What every Server Action in this app hands back to `useActionState`.
 *
 * **This module has no imports, and that is the point.** A client component
 * needs the initial state, while the action modules import `@workspace/db` and
 * `@workspace/user-storage` — so importing the state from beside an action
 * would pull `pg`, `cron-parser` or the AWS SDK into the browser bundle for the
 * sake of one object literal.
 *
 * Serializable by construction: a Server Action's return value crosses the RSC
 * boundary, so an `Error`, a `Date` or a class instance here would fail at
 * runtime rather than at compile time. In particular a `Job` must never be
 * returned — `nextRunAt` is a `Date`.
 *
 * One union for every feature rather than one per feature. The documents and
 * briefings copies were byte-identical apart from their names, which is not
 * surprising: nothing in the shape is domain-specific, and two copies only
 * created somewhere for them to drift apart.
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
       * Distinct per successful action, and used by a form as a React `key` to
       * remount and clear its fields.
       *
       * That is what resets a form **without an effect** — resetting from a
       * `useEffect` means calling `setState` inside it, which cascades a render
       * and which the repo's own `react-hooks/set-state-in-effect` rule flags.
       * Deriving the reset from the action's own result instead is correct by
       * construction: exactly one reset per success, never one per re-render.
       *
       * It is not an identifier and not a cryptographic value, which is why it
       * is no longer called a nonce. What it has to be is *different after every
       * success and stable across everything else* — an id the action just
       * minted (a new row's uuid) satisfies that, and so does a fresh
       * `crypto.randomUUID()`.
       */
      resetKey: string
    }

export const IDLE: ActionState = { status: "idle" }

/**
 * An error state that preserves whatever reset key the previous state held.
 *
 * Not decoration. A form keys its fields on `resetKey`, so a value that
 * disappeared here would be a value that *changed* — and the fields would
 * remount, throwing away what the user typed, at the exact moment they are
 * being told to try again. Carrying it forward makes the key stable across a
 * failure, which is what "one reset per success" was always supposed to mean.
 *
 * Takes the whole previous state rather than a key so that a caller cannot pass
 * the wrong one, and so the `idle` case — nothing to carry — is handled here
 * once instead of at every failure branch.
 */
export function carryResetKey(
  previous: ActionState,
  message: string
): ActionState {
  const resetKey = previous.status === "idle" ? undefined : previous.resetKey

  return { status: "error", message, ...(resetKey ? { resetKey } : {}) }
}
