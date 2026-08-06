import { authClient } from "@/lib/auth/client"

/**
 * Sign out, then land on the sign-in page.
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
}): Promise<void> {
  try {
    await authClient.signOut()
  } catch (cause) {
    console.error("sign-out failed", cause)
  } finally {
    router.refresh()
    router.push("/auth/sign-in")
  }
}
