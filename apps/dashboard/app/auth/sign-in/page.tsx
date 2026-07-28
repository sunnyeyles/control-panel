"use client"

import * as React from "react"

import { authClient } from "@/lib/auth/client"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { BotIcon } from "lucide-react"

/**
 * Built from `@workspace/ui` rather than `@neondatabase/auth-ui`.
 *
 * The prebuilt components ship their own stylesheet, and this repo has exactly
 * one — `packages/ui/src/styles/globals.css`, owned by the UI package. A second
 * one competing with it is a worse trade than a form we write ourselves.
 *
 * There is no sign-up form and there will not be one: signup is closed, and the
 * allowlist in `lib/auth/current-user.ts` is what enforces it.
 */
type Provider = "github" | "google"

export default function SignInPage() {
  const [pending, setPending] = React.useState<Provider | undefined>()
  const [error, setError] = React.useState<string | undefined>()

  async function signIn(provider: Provider) {
    setPending(provider)
    setError(undefined)
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: window.location.origin,
      })
    } catch (cause) {
      console.error(`sign-in: ${provider} failed`, cause)
      setError("Could not start sign-in. Try again.")
      setPending(undefined)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <BotIcon className="size-6" />
          <CardTitle>Control Panel</CardTitle>
          <CardDescription>
            Sign in to continue. Access is limited to approved accounts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            onClick={() => signIn("github")}
            disabled={pending !== undefined}
          >
            {pending === "github" ? "Redirecting…" : "Continue with GitHub"}
          </Button>
          <Button
            variant="outline"
            onClick={() => signIn("google")}
            disabled={pending !== undefined}
          >
            {pending === "google" ? "Redirecting…" : "Continue with Google"}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
