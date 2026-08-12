/**
 * The shapes the user has touched since the agent last looked — what answers
 * "make that one bigger" when nothing is selected.
 *
 * A module-level set rather than React state: it is written on every pointer
 * move of a drag, and state would re-render the canvas hundreds of times per
 * stroke. Nothing renders from it — it is read once, when a turn is sent.
 *
 * ⚠️ It lives here rather than beside the canvas component so its consumers are
 * not forced to import tldraw — that component is behind `dynamic(…, { ssr:
 * false })` precisely because tldraw touches `window` at import time.
 */

const touched = new Set<string>()

/**
 * Ids the agent is writing, awaiting the store notification they will cause.
 *
 * ⚠️ The canvas subscribes with `source: "user"`, which in `@tldraw/store` means
 * *local* rather than *human* — only `mergeRemoteChanges()` produces `"remote"`,
 * and using that would take the agent's turn off the undo stack, since
 * `HistoryManager` ignores every entry not sourced `"user"`. So the agent's
 * edits arrive at `noteUserEdit` indistinguishable from the user's.
 *
 * Consumed on arrival rather than a flag held across the write: `Store`'s
 * history reactor is scheduled with `throttleToNextFrame`, so notifications land
 * a frame *after* `applyOps` returns, by which time a scope guard has closed.
 */
const agentPending = new Set<string>()

/**
 * Claim the next change to this shape for the agent. Ids are tldraw's own.
 */
export function noteAgentEdit(id: string): void {
  agentPending.add(id)
}

/** Record a shape the user created or changed. Ids are tldraw's own. */
export function noteUserEdit(id: string): void {
  if (agentPending.delete(id)) return
  touched.add(id)
}

/**
 * Read and clear.
 *
 * Draining is what makes "recent" mean "since the last turn" rather than "since
 * the page loaded". Unconsumed claims are dropped with the edits, bounding the
 * cost of an agent write that produced no notification to the turn it happened
 * in — left standing, one would swallow the user's next real edit of that shape.
 */
export function drainRecentEdits(): string[] {
  const ids = [...touched]
  touched.clear()
  agentPending.clear()
  return ids
}

/** Forget everything, e.g. when a saved board is loaded over the current one. */
export function clearRecentEdits(): void {
  touched.clear()
  agentPending.clear()
}
