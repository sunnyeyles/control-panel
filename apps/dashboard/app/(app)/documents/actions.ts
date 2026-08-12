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
 *    export becomes a POST endpoint reachable without the UI, so the set is a
 *    security surface and belongs in one auditable place.
 * 2. **Actions live at `app/<segment>/actions.ts`.**
 * 3. **This file is a thin wrapper.** The logic sits behind a
 *    `createXActions(deps)` factory in `lib/`, because the injectable seam is
 *    what lets the authorization branches be tested without a live session.
 * 4. **Every action is `(state, formData) => Promise<State>`**, for
 *    `useActionState`.
 * 5. **Actions return a serializable discriminated union** and never throw for
 *    an expected failure — a thrown error reaches the client as a generic
 *    digest, useless to the user and to the log.
 * 6. **Cache invalidation happens here, not in the core.** `refresh()` needs
 *    Next's request store, which a unit test cannot provide.
 *
 * ⚠️ A `"use server"` file may only export async functions, which is why the
 * state type is re-exported as a type-only alias and the size constants live in
 * `upload-validation.ts`.
 */

/**
 * `refresh()`, not `revalidatePath` or `revalidateTag`.
 *
 * `/documents` is `force-dynamic`, so nothing is in the Data Cache and there is
 * no cached render to invalidate. What needs clearing is the *client router
 * cache* holding the document list this action just changed, and `refresh()` is
 * Next 16's Server-Action-only tool for exactly that. `revalidatePath` also
 * refreshes every previously visited page; `revalidateTag`/`updateTag` need a
 * `use cache` boundary, which requires `cacheComponents: true`.
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
