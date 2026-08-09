import { authClient } from "@/lib/auth/client"

/**
 * Sign out, then land on the sign-in page — only if the sign-out happened.
 *
 * The Neon client hardcodes `throw: false` into its better-fetch options, so a
 * refusal resolves as `{ data: null, error }` rather than rejecting — the same
 * trap the sign-in form guards against. Navigating regardless would tell the
 * user they signed out while the session cookie is still live, so a refusal is
 * logged and reported to the caller instead, which resets its pending state.
 *
 * `router.refresh()` before navigating so the server components that read the
 * session are re-rendered rather than served from the client router cache —
 * without it the sidebar keeps showing the person who just left.
 *
 * Shared by `SignOutButton` and `NavUser` so the sequence cannot drift.
 */
export async function signOutAndRedirect(router: {
  refresh: () => void
  push: (href: string) => void
}): Promise<boolean> {
  try {
    const result = await authClient.signOut()
    if (result?.error) {
      console.error("sign-out refused", result.error)
      return false
    }
  } catch (cause) {
    console.error("sign-out failed", cause)
    return false
  }
  router.refresh()
  router.push("/auth/sign-in")
  return true
}
