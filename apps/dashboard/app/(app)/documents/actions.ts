"use server"

import { getCurrentUser } from "@/lib/auth/current-user"
import type { ActionState } from "@/lib/actions/action-state"
import { getPrisma } from "@/lib/db"
import { createDocumentActions } from "@/lib/documents/document-actions"
import { getResumeStore } from "@/lib/storage"
import { refresh } from "next/cache"
import { headers } from "next/headers"

/**
 * The repository's first Server Actions, so this file sets the convention.
 *
 * 1. **`"use server"` at the top of a dedicated file, never inline.** Every
 *    export here becomes a POST endpoint reachable without going through the
 *    UI, so the set of them is a security surface and belongs in one auditable
 *    place rather than scattered through components.
 * 2. **Actions live at `app/<segment>/actions.ts`**, colocated with the segment
 *    that owns them.
 * 3. **This file is a thin wrapper.** The logic is in
 *    `lib/documents/document-actions.ts`, behind a `createXActions(deps)`
 *    factory — the same shape as `lib/chat-handler.ts`, and for the same
 *    reason: the injectable seam is what lets the authorization branches be
 *    tested without a live session.
 * 4. **Every action is `(state, formData) => Promise<State>`**, so it drops
 *    straight into `useActionState`.
 * 5. **Actions return a serializable discriminated union** and never throw for
 *    an expected failure. A thrown error in a Server Action reaches the client
 *    as a generic digest, which is useless to the user and to the log.
 * 6. **Cache invalidation happens here, not in the core.** `refresh()` needs
 *    Next's request store, which a unit test cannot provide.
 *
 * A `"use server"` file may only export async functions, which is why the state
 * type is re-exported through a type-only alias and the size constants live in
 * `upload-validation.ts`.
 */

/**
 * `refresh()`, not `revalidatePath` or `revalidateTag`.
 *
 * `/documents` is `force-dynamic` because it reads cookies, so nothing about it
 * is in the Data Cache and there is no cached render to invalidate. What
 * actually needs clearing is the *client router cache*, which is holding the
 * document list this action just changed.
 *
 * `refresh()` is Next 16's Server-Action-only tool for precisely that.
 * `revalidatePath` would work, but its own documentation notes it also
 * refreshes every previously visited page in the router cache — a bigger hammer
 * for no benefit. `revalidateTag` and `updateTag` need a `use cache` boundary,
 * which requires `cacheComponents: true`, which this app does not set.
 */
const actions = createDocumentActions({
  getUser: getCurrentUser,
  getResumes: getResumeStore,
  getPrisma,
  getContentLength: async () => {
    const value = (await headers()).get("content-length")
    if (!value) return undefined

    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  },
})

export async function uploadDocumentAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.uploadDocument(state, formData)

  if (result.status === "success") refresh()

  return result
}

export async function deleteDocumentAction(
  state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const result = await actions.deleteDocument(state, formData)

  if (result.status === "success") refresh()

  return result
}
