/**
 * The shapes the user has touched since the agent last looked.
 *
 * This is what answers "turn what I just drew into a proper architecture" and
 * "make that one bigger" when nothing is selected — the second of the four
 * reference signals the whiteboard prompt reasons from.
 *
 * A module-level set rather than React state, on purpose. It is written on
 * every pointer move of a drag; making it state would re-render the canvas
 * hundreds of times per stroke. Nothing renders from it — it is read once,
 * when a turn is sent, and cleared.
 *
 * It lives here rather than beside the canvas component so the pieces that
 * need it are not forced to import tldraw. That component is behind
 * `dynamic(..., { ssr: false })` precisely because tldraw touches `window` at
 * import time, and an innocent-looking import of a helper from it would undo
 * that.
 */

const touched = new Set<string>()

/**
 * Ids the agent is writing, awaiting the store notification they will cause.
 *
 * The canvas subscribes with `source: "user"`, which in `@tldraw/store` means
 * *local* rather than *human* — only `store.mergeRemoteChanges()` produces
 * `"remote"`, and using that would take the agent's turn off the undo stack,
 * since `HistoryManager` ignores every entry that is not sourced `"user"`. So
 * the agent's edits arrive at `noteUserEdit` indistinguishable from the user's,
 * and this set is how they are told apart.
 *
 * A set consumed on arrival rather than a flag held across the write, because
 * `Store`'s history reactor is scheduled with `throttleToNextFrame` — the
 * notifications land a frame *after* `applyOps` returns, by which time any
 * scope-based guard has already closed.
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
 * Draining rather than reading is what makes "recent" mean "since the last
 * turn" instead of "since the page loaded" — otherwise the first thing the
 * user drew would still be claimed as new an hour later.
 *
 * Unconsumed claims are dropped along with the edits, which bounds the cost of
 * an agent write that produced no notification — an op that threw, or an update
 * that changed nothing — to the turn it happened in. Left standing, one would
 * swallow the user's next real edit of that shape whenever it came.
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
