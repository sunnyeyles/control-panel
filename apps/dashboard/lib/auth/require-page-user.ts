import { redirect } from "next/navigation"

import { getCurrentUser } from "@/lib/auth/current-user"

/**
 * The gate every page under `app/(app)/` performs for itself.
 *
 * ⚠️ **This is the authorization check, and it must stay a per-page call.**
 * `app/(app)/layout.tsx` also calls `getCurrentUser()`, but for the sidebar: a
 * layout does not re-render on navigation, so its check is not re-run when
 * someone moves between routes. Next's own guide prescribes exactly this split.
 * Deleting a page's call because "the layout already checks" reopens the hole —
 * this helper is only the three copied lines, not a check performed once.
 *
 * The duplicate call costs nothing: `getCurrentUser` is wrapped in React's
 * `cache()`, so both share one session lookup per request.
 *
 * Unlike the API routes and Server Actions, which conflate "anonymous" and
 * "refused" behind one 401, the pages **do** distinguish them — by here the user
 * is identified and is being told about their own account.
 *
 * @returns the signed-in, allowlisted user. Never returns otherwise: `redirect()`
 *   throws, so there is no falsy case for a caller to forget to handle.
 */
export async function requirePageUser() {
  const user = await getCurrentUser()

  if (user.status === "anonymous") redirect("/auth/sign-in")
  if (user.status === "refused") redirect("/auth/refused")

  return user
}
