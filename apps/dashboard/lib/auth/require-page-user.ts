import { redirect } from "next/navigation"

import { getCurrentUser } from "@/lib/auth/current-user"

/**
 * The gate every page under `app/(app)/` performs for itself.
 *
 * ⚠️ **This is the authorization check, and it must stay a per-page call.**
 * `app/(app)/layout.tsx` also calls `getCurrentUser()`, but that call is for the
 * sidebar: a layout does not re-render on navigation, so its check is not re-run
 * when someone moves between routes. Next's own authentication guide warns about
 * exactly this and prescribes the split used here — fetch the user in the layout
 * to display it, keep the authorization check in each page. Deleting a page's
 * call because "the layout already checks" reopens the hole.
 *
 * Extracting it into this function changes none of that. Each page still calls
 * it, on every render, and the redirects still happen inside the page's own
 * render. What is gone is only the three-line copy that had begun to appear
 * verbatim in every new page — which is the version of this that *does* drift,
 * because a fourth page is written by copying a third.
 *
 * The duplicate call costs nothing: `getCurrentUser` is wrapped in React's
 * `cache()`, so the layout and the page share one session lookup and one
 * identity upsert per request.
 *
 * Unlike the API routes and Server Actions, which conflate "anonymous" and
 * "refused" behind one 401, the pages **do** distinguish them — by this point
 * the user has been identified and is being told about their own account.
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
