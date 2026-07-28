import { redirect } from "next/navigation"

import { getCurrentUser } from "@/lib/auth/current-user"
import { SignOutButton } from "@/components/sign-out-button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

/**
 * Signed in, but not on the allowlist.
 *
 * A state of its own rather than a redirect back to sign-in, which would loop:
 * this person *has* a valid session, so the proxy lets them through and sign-in
 * would just hand them the same session again. The only useful action here is
 * signing out.
 */
export const dynamic = "force-dynamic"

export default async function RefusedPage() {
  const user = await getCurrentUser()

  if (user.status === "anonymous") redirect("/auth/sign-in")
  if (user.status === "ok") redirect("/")

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>No access</CardTitle>
          <CardDescription>
            <span className="font-medium">{user.email}</span> is not approved
            for this dashboard. Ask for an invite, or sign in with a different
            account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton className="w-full" />
        </CardContent>
      </Card>
    </main>
  )
}
