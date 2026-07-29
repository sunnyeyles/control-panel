/**
 * What a document action hands back to `useActionState`.
 *
 * Its own module, with no imports, and that is the entire point. A client
 * component needs the initial state, and `document-actions.ts` imports
 * `@workspace/user-storage` — so importing the state from there would pull the
 * AWS SDK into the browser bundle for the sake of one object literal.
 *
 * Serializable by construction: a Server Action's return value crosses the
 * RSC boundary, so an Error, a Date or a class instance here would fail at
 * runtime rather than at compile time.
 */
export type DocumentActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "success"
      message: string
      /**
       * Distinct per successful action, and the uploader uses it as a React
       * `key` to remount its fields.
       *
       * That is what resets the form — a fresh `<input type="file">` and a
       * fresh inferred type — **without an effect**. Resetting from a
       * `useEffect` means calling `setState` inside it, which cascades a render
       * and which the repo's own lint rules flag. Deriving the reset from the
       * action's own result instead is both simpler and correct by
       * construction: exactly one reset per success, never one on a re-render.
       */
      nonce: string
    }

export const IDLE: DocumentActionState = { status: "idle" }
