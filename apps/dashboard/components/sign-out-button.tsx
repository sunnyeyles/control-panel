"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { signOutAndRedirect } from "@/lib/auth/sign-out"
import { Button } from "@workspace/ui/components/button"

/**
 * Sign out, then land on the sign-in page.
 *
 * Sequence lives in `signOutAndRedirect` so `NavUser` cannot drift from this
 * button.
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
    await signOutAndRedirect(router)
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
