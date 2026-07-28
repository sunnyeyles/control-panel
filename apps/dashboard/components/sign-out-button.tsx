"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { authClient } from "@/lib/auth/client"
import { Button } from "@workspace/ui/components/button"

/**
 * Sign out, then land on the sign-in page.
 *
 * `router.refresh()` before navigating so the server components that read the
 * session are re-rendered rather than served from the client router cache —
 * without it the sidebar keeps showing the person who just left.
 */
export function SignOutButton({
  className,
  variant = "outline",
}: {
  className?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  async function signOut() {
    setPending(true)
    try {
      await authClient.signOut()
    } catch (cause) {
      console.error("sign-out failed", cause)
    } finally {
      router.refresh()
      router.push("/auth/sign-in")
    }
  }

  return (
    <Button
      variant={variant}
      className={className}
      onClick={signOut}
      disabled={pending}
    >
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  )
}
